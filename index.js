const { App } = require('@slack/bolt');
const { google } = require('googleapis');
require('dotenv').config();

// ── Slack 앱 초기화 ──────────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// ── Google Sheets 초기화 ─────────────────────────────────────────
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || '시트1';
const REVIEWER_SLACK_ID = process.env.REVIEWER_SLACK_ID;

// 수요일 발송 불가 슬롯
const WED_BLOCKED_HOURS = [11, 12, 13];

// ── /bt 슬래시 커맨드 → 모달 오픈 ───────────────────────────────
app.command('/bt', async ({ command, ack, client, logger }) => {
  await ack();
  try {
    await client.views.open({
      trigger_id: command.trigger_id,
      view: buildModal(),
    });
  } catch (error) {
    logger.error(error);
  }
});

// ── 모달 빌더 ────────────────────────────────────────────────────
function buildModal() {
  return {
    type: 'modal',
    callback_id: 'bt_modal',
    title: { type: 'plain_text', text: '번개톡 발송 검토 요청' },
    submit: { type: 'plain_text', text: '검토 요청' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      {
        type: 'input',
        block_id: 'send_date',
        label: { type: 'plain_text', text: '발송 예정 날짜' },
        hint: { type: 'plain_text', text: '형식: YYYY-MM-DD (예: 2026-04-10)' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'YYYY-MM-DD' },
        },
      },
      {
        type: 'input',
        block_id: 'slots',
        label: { type: 'plain_text', text: '시간대별 발송 수량' },
        hint: {
          type: 'plain_text',
          text: '한 줄에 하나씩 입력 | 형식: HH:MM~HH:MM, 수량\n예) 14:00~15:00, 400000\n    14:30~15:30, 200000',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: '14:00~15:00, 400000\n15:00~16:00, 300000',
          },
        },
      },
      {
        type: 'input',
        block_id: 'title',
        label: { type: 'plain_text', text: '제목' },
        element: { type: 'plain_text_input', action_id: 'value' },
      },
      {
        type: 'input',
        block_id: 'body',
        label: { type: 'plain_text', text: '본문' },
        element: { type: 'plain_text_input', action_id: 'value', multiline: true },
      },
      {
        type: 'input',
        block_id: 'marketing_consent',
        label: { type: 'plain_text', text: '마케팅 수신 동의 여부' },
        element: {
          type: 'radio_buttons',
          action_id: 'value',
          options: [
            { text: { type: 'plain_text', text: 'O (동의)' }, value: 'Y' },
            { text: { type: 'plain_text', text: 'X (미동의)' }, value: 'N' },
          ],
        },
      },
    ],
  };
}

// ── 모달 제출 처리 ────────────────────────────────────────────────
app.view('bt_modal', async ({ ack, body, view, client, logger }) => {
  const v = view.state.values;
  const user = body.user;

  const sendDateStr = v.send_date.value.value.trim();
  const slotsRaw = v.slots.value.value.trim();
  const title = v.title.value.value.trim();
  const bodyText = v.body.value.value.trim();
  const marketingConsent = v.marketing_consent.value.selected_option.value;

  // 날짜 파싱
  const dateMatch = sendDateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) {
    await ack({
      response_action: 'errors',
      errors: { send_date: 'YYYY-MM-DD 형식으로 입력해주세요. (예: 2026-04-10)' },
    });
    return;
  }

  const sendDate = new Date(dateMatch[1], dateMatch[2] - 1, dateMatch[3]);
  const dayOfWeek = sendDate.getDay(); // 0=일, 1=월, 3=수

  // 슬롯 파싱
  const parsedSlots = parseSlots(slotsRaw);
  if (parsedSlots.error) {
    await ack({
      response_action: 'errors',
      errors: { slots: parsedSlots.error },
    });
    return;
  }

  await ack();

  const requestDatetime = formatDatetime(new Date());
  const rowId = Date.now().toString();
  const slotResults = [];
  let hasReject = false;
  let hasManualReview = false;

  for (const slot of parsedSlots.slots) {
    const { startHour, startMin, endHour, endMin, count, label } = slot;
    const slotRejects = [];
    let slotManual = false;

    // [1] 시간대 범위 체크 (08~20시)
    if (startHour < 8 || startHour >= 20) {
      slotRejects.push(`발송 시간 범위 초과 (허용: 08~20시 / 입력: ${label})`);
    }

    // [2] 수요일 블락 슬롯 체크
    if (dayOfWeek === 3 && WED_BLOCKED_HOURS.includes(startHour)) {
      slotRejects.push(`수요일 발송 불가 슬롯 (11·12·13시 / 입력: ${label})`);
    }

    // [3] 슬롯 40만 체크 (시작 시간 기준 hour 슬롯)
    if (slotRejects.length === 0) {
      const existing = await getSlotTotal(sendDate, startHour);
      const newTotal = existing + count;
      if (newTotal > 400000) {
        slotRejects.push(
          `슬롯 초과 (${startHour}시 슬롯 기존 ${existing.toLocaleString()}건 + 요청 ${count.toLocaleString()}건 = ${newTotal.toLocaleString()}건 > 40만)`
        );
      }
    }

    // [4] 월요일 18시 이전 체크
    if (slotRejects.length === 0 && dayOfWeek === 1 && startHour < 18) {
      slotManual = true;
      hasManualReview = true;
    }

    // [5] 마수신 동의 키워드 체크
    if (slotRejects.length === 0 && !slotManual && marketingConsent === 'Y') {
      if (!title.includes('(광고)')) {
        slotRejects.push('제목에 "(광고)" 미포함');
      }
      if (!bodyText.includes('수신거부') || !bodyText.includes('알림설정')) {
        slotRejects.push('본문에 "수신거부:알림설정" 미포함');
      }
    }

    const slotResult = slotRejects.length > 0
      ? `반려 (${slotRejects.join(' / ')})`
      : slotManual ? '수동확인 대기' : '승인';

    if (slotRejects.length > 0) hasReject = true;

    slotResults.push({
      label,
      startHour,
      startMin,
      count,
      result: slotResult,
      rejects: slotRejects,
      manual: slotManual,
    });

    // 시트 기록
    await writeToSheet({
      rowId: `${rowId}_${startHour}_${startMin}`,
      requestDatetime,
      requester: user.name,
      sendDatetime: `${sendDateStr} ${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}`,
      sendCount: count,
      title,
      body: bodyText,
      marketingConsent,
      result: slotResult,
    });
  }

  // ── 요청자 DM 결과 요약 ──────────────────────────────────────
  const overallEmoji = hasReject ? '❌' : hasManualReview ? '⏳' : '✅';
  const overallLabel = hasReject ? '일부 반려 포함' : hasManualReview ? '일부 수동확인 대기' : '전체 승인';

  let resultText = `*${overallEmoji} 번개톡 발송 검토 결과*\n\n`;
  resultText += `*발송 예정 날짜:* ${sendDateStr}\n`;
  resultText += `*마수신 동의:* ${marketingConsent}\n\n`;
  resultText += `*시간대별 결과:*\n`;

  for (const slot of slotResults) {
    const e = slot.result === '승인' ? '✅' : slot.result === '수동확인 대기' ? '⏳' : '❌';
    resultText += `${e} *${slot.label}* | ${slot.count.toLocaleString()}건 | ${slot.result}\n`;
  }

  await client.chat.postMessage({
    channel: user.id,
    text: `${overallEmoji} 번개톡 검토 결과: ${overallLabel}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: resultText } }],
  });

  // ── 수동확인 슬롯 담당자 DM ──────────────────────────────────
  const manualSlots = slotResults.filter(s => s.manual);
  if (manualSlots.length > 0) {
    const manualDetail = manualSlots
      .map(s => `• ${s.label} | ${s.count.toLocaleString()}건`)
      .join('\n');

    const actionPayload = JSON.stringify({
      rowId,
      userId: user.id,
      sendDateStr,
      manualSlots: manualSlots.map(s => ({
        label: s.label,
        startHour: s.startHour,
        startMin: s.startMin,
        count: s.count,
      })),
      title,
      bodyText,
      marketingConsent,
    });

    await client.chat.postMessage({
      channel: REVIEWER_SLACK_ID,
      text: '⚠️ 번개톡 수동 확인 요청',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              '*⚠️ 번개톡 수동 확인 요청*',
              `월요일 18시 이전 발송 요청입니다.\n`,
              `*요청자:* <@${user.id}>`,
              `*발송 예정 날짜:* ${sendDateStr}`,
              `*수동확인 슬롯:*\n${manualDetail}`,
              `*제목:* ${title}`,
              `*본문:* ${bodyText.substring(0, 100)}${bodyText.length > 100 ? '...' : ''}`,
              `*마수신 동의:* ${marketingConsent}`,
            ].join('\n'),
          },
        },
        {
          type: 'actions',
          block_id: 'manual_review_actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ 승인' },
              style: 'primary',
              action_id: 'manual_approve',
              value: actionPayload,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '❌ 반려' },
              style: 'danger',
              action_id: 'manual_reject',
              value: actionPayload,
              confirm: {
                title: { type: 'plain_text', text: '반려 확인' },
                text: { type: 'mrkdwn', text: '이 요청을 반려하시겠습니까?' },
                confirm: { type: 'plain_text', text: '반려' },
                deny: { type: 'plain_text', text: '취소' },
              },
            },
          ],
        },
      ],
    });
  }
});

// ── 수동 승인 버튼 ────────────────────────────────────────────────
app.action('manual_approve', async ({ ack, body, action, client, logger }) => {
  await ack();
  try {
    const data = JSON.parse(action.value);
    const slotLabels = data.manualSlots.map(s => s.label).join(', ');

    for (const slot of data.manualSlots) {
      await updateSheetResult(`${data.rowId}_${slot.startHour}_${slot.startMin}`, '승인 (수동)');
    }

    await client.chat.postMessage({
      channel: data.userId,
      text: `✅ 번개톡 발송 요청이 승인되었습니다.\n발송 예정: ${data.sendDateStr} | ${slotLabels}`,
    });

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `✅ 승인 처리 완료`,
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *승인 처리 완료*\n요청자: <@${data.userId}> | ${data.sendDateStr} ${slotLabels}`,
        },
      }],
    });
  } catch (error) {
    logger.error(error);
  }
});

// ── 수동 반려 버튼 ────────────────────────────────────────────────
app.action('manual_reject', async ({ ack, body, action, client, logger }) => {
  await ack();
  try {
    const data = JSON.parse(action.value);
    const slotLabels = data.manualSlots.map(s => s.label).join(', ');

    for (const slot of data.manualSlots) {
      await updateSheetResult(`${data.rowId}_${slot.startHour}_${slot.startMin}`, '반려 (수동)');
    }

    await client.chat.postMessage({
      channel: data.userId,
      text: `❌ 번개톡 발송 요청이 반려되었습니다.\n발송 예정: ${data.sendDateStr} | ${slotLabels}\n담당자에게 문의해주세요.`,
    });

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `❌ 반려 처리 완료`,
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `❌ *반려 처리 완료*\n요청자: <@${data.userId}> | ${data.sendDateStr} ${slotLabels}`,
        },
      }],
    });
  } catch (error) {
    logger.error(error);
  }
});

// ── 슬롯 텍스트 파싱 ─────────────────────────────────────────────
// 입력 형식: HH:MM~HH:MM, 수량 (1시간 단위 필수)
function parseSlots(raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return { error: '시간대를 1개 이상 입력해주세요.' };

  const slots = [];
  for (const line of lines) {
    const match = line.match(
      /^(\d{1,2}):(\d{2})~(\d{1,2}):(\d{2})\s*[,\s]\s*([\d,]+)$/
    );
    if (!match) {
      return {
        error: `입력 형식 오류: "${line}"\n올바른 형식: 14:00~15:00, 400000`,
      };
    }

    const startHour = parseInt(match[1]);
    const startMin = parseInt(match[2]);
    const endHour = parseInt(match[3]);
    const endMin = parseInt(match[4]);
    const count = parseInt(match[5].replace(/,/g, ''));

    // 범위가 정확히 1시간인지 체크 (분 단위 허용)
    const startTotal = startHour * 60 + startMin;
    const endTotal = endHour * 60 + endMin;
    if (endTotal - startTotal !== 60) {
      return {
        error: `발송 범위는 정확히 1시간이어야 합니다: "${line}"\n예) 14:00~15:00, 14:30~15:30`,
      };
    }

    const label = `${String(startHour).padStart(2,'0')}:00~${String(endHour).padStart(2,'0')}:00`;

    slots.push({ startHour, startMin, endHour, endMin, count, label });
  }

  return { slots };
}

// ── Google Sheets 유틸 ────────────────────────────────────────────
async function getSlotTotal(sendDate, targetHour) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:I`,
    });

    const rows = res.data.values || [];
    const targetDateStr = toDateStr(sendDate);
    let total = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[3] || !row[4]) continue;
      const rowDatetime = parseDatetime(row[3]);
      if (!rowDatetime) continue;
      const rowResult = (row[8] || '').trim();
      if (toDateStr(rowDatetime) !== targetDateStr) continue;
      if (rowDatetime.getHours() !== targetHour) continue;
      if (!rowResult.startsWith('승인')) continue;
      total += parseInt(row[4]) || 0;
    }
    return total;
  } catch (error) {
    console.error('시트 읽기 오류:', error);
    return 0;
  }
}

async function writeToSheet(data) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:I`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          data.rowId,
          data.requestDatetime,
          data.requester,
          data.sendDatetime,
          data.sendCount,
          data.title,
          data.body,
          data.marketingConsent,
          data.result,
        ]],
      },
    });
  } catch (error) {
    console.error('시트 쓰기 오류:', error);
  }
}

async function updateSheetResult(rowId, newResult) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:I`,
    });
    const rows = res.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === rowId) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!I${i + 1}`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [[newResult]] },
        });
        return;
      }
    }
  } catch (error) {
    console.error('시트 업데이트 오류:', error);
  }
}

// ── 날짜 유틸 ─────────────────────────────────────────────────────
function parseDatetime(str) {
  if (!str) return null;
  const m = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  return new Date(m[1], m[2] - 1, m[3], m[4], m[5]);
}

function toDateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDatetime(date) {
  return `${toDateStr(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// ── 서버 시작 ─────────────────────────────────────────────────────
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ 번개톡 봇 실행 중');
})();
