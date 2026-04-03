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

// 발송 가능 시간대 (08~20시)
const VALID_HOURS = Array.from({ length: 12 }, (_, i) => i + 8); // [8,9,...,19]

// 수요일 발송 불가 슬롯
const WED_BLOCKED_HOURS = [11, 12, 13];

// ── /bt 슬래시 커맨드 → 1단계 모달 ─────────────────────────────
app.command('/bt', async ({ command, ack, client, logger }) => {
  await ack();

  try {
    await client.views.open({
      trigger_id: command.trigger_id,
      view: buildStep1Modal(),
    });
  } catch (error) {
    logger.error(error);
  }
});

// ── 1단계 모달 빌더 ──────────────────────────────────────────────
function buildStep1Modal(privateMetadata = '{}') {
  return {
    type: 'modal',
    callback_id: 'bt_modal_step1',
    private_metadata: privateMetadata,
    title: { type: 'plain_text', text: '번개톡 검토 요청 (1/2)' },
    submit: { type: 'plain_text', text: '다음' },
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
        block_id: 'send_hours',
        label: { type: 'plain_text', text: '발송 시간대 (복수 선택 가능)' },
        hint: { type: 'plain_text', text: '각 시간대 = 해당 시 ~ 다음 시 (예: 14시 = 14:00~15:00)' },
        element: {
          type: 'checkboxes',
          action_id: 'value',
          options: VALID_HOURS.map(h => ({
            text: { type: 'plain_text', text: `${h}시` },
            value: String(h),
          })),
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

// ── 1단계 모달 제출 → 유효성 검사 후 2단계 모달 ────────────────
app.view('bt_modal_step1', async ({ ack, body, view, client, logger }) => {
  const v = view.state.values;
  const user = body.user;

  const sendDateStr = v.send_date.value.value.trim();
  const selectedHours = (v.send_hours.value.selected_options || []).map(o => parseInt(o.value));
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

  // 시간대 선택 여부
  if (selectedHours.length === 0) {
    await ack({
      response_action: 'errors',
      errors: { send_hours: '발송 시간대를 1개 이상 선택해주세요.' },
    });
    return;
  }

  // 수요일 블락 슬롯 체크
  if (dayOfWeek === 3) {
    const blockedSelected = selectedHours.filter(h => WED_BLOCKED_HOURS.includes(h));
    if (blockedSelected.length > 0) {
      await ack({
        response_action: 'errors',
        errors: {
          send_hours: `수요일 ${blockedSelected.map(h => h + '시').join(', ')} 슬롯은 발송 불가입니다.`,
        },
      });
      return;
    }
  }

  await ack();

  // 1단계 데이터를 2단계 모달에 전달
  const metadata = JSON.stringify({
    sendDateStr,
    selectedHours,
    title,
    bodyText,
    marketingConsent,
    userId: user.id,
    userName: user.name,
    requestDatetime: formatDatetime(new Date()),
  });

  try {
    await client.views.push({
      trigger_id: body.trigger_id,
      view: buildStep2Modal(selectedHours, metadata),
    });
  } catch (error) {
    logger.error(error);
  }
});

// ── 2단계 모달 빌더 ──────────────────────────────────────────────
function buildStep2Modal(selectedHours, metadata) {
  return {
    type: 'modal',
    callback_id: 'bt_modal_step2',
    private_metadata: metadata,
    title: { type: 'plain_text', text: '번개톡 검토 요청 (2/2)' },
    submit: { type: 'plain_text', text: '검토 요청' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '선택한 시간대별 발송 수량을 입력해주세요.' },
      },
      ...selectedHours.map(h => ({
        type: 'input',
        block_id: `count_${h}`,
        label: { type: 'plain_text', text: `${h}시 슬롯 (${h}:00~${h + 1}:00) 발송 수량` },
        hint: { type: 'plain_text', text: '숫자만 입력 (예: 400000)' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: '400000' },
        },
      })),
    ],
  };
}

// ── 2단계 모달 제출 → 검토 로직 ─────────────────────────────────
app.view('bt_modal_step2', async ({ ack, body, view, client, logger }) => {
  await ack();

  const v = view.state.values;
  const meta = JSON.parse(view.private_metadata);
  const { sendDateStr, selectedHours, title, bodyText, marketingConsent, userId, userName, requestDatetime } = meta;

  const sendDate = parseDateStr(sendDateStr);
  const dayOfWeek = sendDate.getDay();

  // 시간대별 수량 파싱
  const slotCounts = {};
  for (const h of selectedHours) {
    const raw = (v[`count_${h}`]?.value?.value || '').replace(/,/g, '').trim();
    slotCounts[h] = parseInt(raw) || 0;
  }

  // 슬롯별 검토
  const slotResults = [];
  let hasReject = false;
  let hasManualReview = false;

  for (const h of selectedHours) {
    const count = slotCounts[h];
    const slotRejects = [];
    let slotManual = false;

    // [1] 시간대 범위 (08~20시) - 1단계에서 이미 필터됐지만 방어 처리
    if (h < 8 || h >= 20) {
      slotRejects.push('발송 시간 범위 초과 (허용: 08~20시)');
    }

    // [2] 수요일 블락 슬롯 - 1단계에서 걸렸지만 방어 처리
    if (dayOfWeek === 3 && WED_BLOCKED_HOURS.includes(h)) {
      slotRejects.push('수요일 발송 불가 슬롯 (11·12·13시)');
    }

    // [3] 슬롯 40만 체크
    if (slotRejects.length === 0) {
      const existing = await getSlotTotal(sendDate, h);
      const newTotal = existing + count;
      if (newTotal > 400000) {
        slotRejects.push(
          `슬롯 초과 (기존 ${existing.toLocaleString()}건 + 요청 ${count.toLocaleString()}건 = ${newTotal.toLocaleString()}건 > 40만)`
        );
      }
    }

    // [4] 월요일 18시 이전
    if (slotRejects.length === 0 && dayOfWeek === 1 && h < 18) {
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

    slotResults.push({ hour: h, count, result: slotResult, rejects: slotRejects, manual: slotManual });
  }

  // ── 시트 기록 (슬롯별 각 1행) ────────────────────────────────
  const rowId = Date.now().toString();
  for (const slot of slotResults) {
    await writeToSheet({
      rowId: `${rowId}_${slot.hour}`,
      requestDatetime,
      requester: userName,
      sendDatetime: `${sendDateStr} ${String(slot.hour).padStart(2, '0')}:00`,
      sendCount: slot.count,
      title,
      body: bodyText,
      marketingConsent,
      result: slot.result,
    });
  }

  // ── 요청자 DM 결과 요약 ──────────────────────────────────────
  const overallEmoji = hasReject ? '❌' : hasManualReview ? '⏳' : '✅';
  const overallLabel = hasReject ? '일부 반려' : hasManualReview ? '일부 수동확인 대기' : '전체 승인';

  let resultText = `*${overallEmoji} 번개톡 발송 검토 결과*\n\n`;
  resultText += `*발송 예정 날짜:* ${sendDateStr}\n`;
  resultText += `*마수신 동의:* ${marketingConsent}\n\n`;
  resultText += `*시간대별 결과:*\n`;

  for (const slot of slotResults) {
    const e = slot.result === '승인' ? '✅' : slot.result === '수동확인 대기' ? '⏳' : '❌';
    resultText += `${e} *${slot.hour}시 슬롯* | ${slot.count.toLocaleString()}건 | ${slot.result}\n`;
  }

  await client.chat.postMessage({
    channel: userId,
    text: `${overallEmoji} 번개톡 검토 결과: ${overallLabel}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: resultText } }],
  });

  // ── 수동확인 슬롯만 추려서 담당자 DM ────────────────────────
  const manualSlots = slotResults.filter(s => s.manual);
  if (manualSlots.length > 0) {
    const manualDetail = manualSlots
      .map(s => `• ${s.hour}시 슬롯 | ${s.count.toLocaleString()}건`)
      .join('\n');

    const actionPayload = JSON.stringify({
      rowId,
      userId,
      sendDateStr,
      manualSlots: manualSlots.map(s => ({ hour: s.hour, count: s.count })),
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
              `*요청자:* <@${userId}>`,
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
    const slotLabels = data.manualSlots.map(s => `${s.hour}시`).join(', ');

    // 해당 슬롯 시트 결과 업데이트
    for (const slot of data.manualSlots) {
      await updateSheetResult(`${data.rowId}_${slot.hour}`, '승인 (수동)');
    }

    await client.chat.postMessage({
      channel: data.userId,
      text: `✅ 번개톡 발송 요청이 승인되었습니다.\n발송 예정: ${data.sendDateStr} ${slotLabels} 슬롯`,
    });

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `✅ 승인 처리 완료`,
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `✅ *승인 처리 완료*\n요청자: <@${data.userId}> | ${data.sendDateStr} ${slotLabels} 슬롯` },
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
    const slotLabels = data.manualSlots.map(s => `${s.hour}시`).join(', ');

    for (const slot of data.manualSlots) {
      await updateSheetResult(`${data.rowId}_${slot.hour}`, '반려 (수동)');
    }

    await client.chat.postMessage({
      channel: data.userId,
      text: `❌ 번개톡 발송 요청이 반려되었습니다.\n발송 예정: ${data.sendDateStr} ${slotLabels} 슬롯\n담당자에게 문의해주세요.`,
    });

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `❌ 반려 처리 완료`,
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `❌ *반려 처리 완료*\n요청자: <@${data.userId}> | ${data.sendDateStr} ${slotLabels} 슬롯` },
      }],
    });
  } catch (error) {
    logger.error(error);
  }
});

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
function parseDateStr(str) {
  const m = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(m[1], m[2] - 1, m[3]);
}

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
