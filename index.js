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

// ── /bt 슬래시 커맨드 → 모달 오픈 ───────────────────────────────
app.command('/bt', async ({ command, ack, client, logger }) => {
  await ack();

  try {
    await client.views.open({
      trigger_id: command.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'bt_modal',
        title: { type: 'plain_text', text: '번개톡 발송 검토 요청' },
        submit: { type: 'plain_text', text: '검토 요청' },
        close: { type: 'plain_text', text: '취소' },
        blocks: [
          {
            type: 'input',
            block_id: 'send_datetime',
            label: { type: 'plain_text', text: '발송 예정 일시' },
            hint: { type: 'plain_text', text: '형식: YYYY-MM-DD HH:MM (예: 2024-04-10 14:00)' },
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'YYYY-MM-DD HH:MM' },
            },
          },
          {
            type: 'input',
            block_id: 'send_count',
            label: { type: 'plain_text', text: '발송 수량' },
            hint: { type: 'plain_text', text: '숫자만 입력 (예: 300000)' },
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: '300000' },
            },
          },
          {
            type: 'input',
            block_id: 'title',
            label: { type: 'plain_text', text: '제목' },
            element: {
              type: 'plain_text_input',
              action_id: 'value',
            },
          },
          {
            type: 'input',
            block_id: 'body',
            label: { type: 'plain_text', text: '본문' },
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              multiline: true,
            },
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
      },
    });
  } catch (error) {
    logger.error(error);
  }
});

// ── 모달 제출 처리 ────────────────────────────────────────────────
app.view('bt_modal', async ({ ack, body, view, client, logger }) => {
  await ack();

  const v = view.state.values;
  const user = body.user;

  // 입력값 추출
  const sendDatetimeStr = v.send_datetime.value.value.trim();
  const sendCountRaw = v.send_count.value.value.replace(/,/g, '').trim();
  const title = v.title.value.value.trim();
  const bodyText = v.body.value.value.trim();
  const marketingConsent = v.marketing_consent.value.selected_option.value;

  const requestDatetime = new Date();
  const requestDatetimeStr = formatDatetime(requestDatetime);

  // 발송일시 파싱
  const sendDatetime = parseDatetime(sendDatetimeStr);
  if (!sendDatetime) {
    await client.chat.postMessage({
      channel: user.id,
      text: `❌ 날짜 형식 오류: \`${sendDatetimeStr}\`\n\`YYYY-MM-DD HH:MM\` 형식으로 다시 입력해주세요.`,
    });
    return;
  }

  const sendCount = parseInt(sendCountRaw);
  if (isNaN(sendCount)) {
    await client.chat.postMessage({
      channel: user.id,
      text: `❌ 발송 수량 형식 오류: \`${sendCountRaw}\`\n숫자만 입력해주세요.`,
    });
    return;
  }

  const sendHour = sendDatetime.getHours();
  const sendDay = sendDatetime.getDay(); // 0=일, 1=월
  const sendMinute = sendDatetime.getMinutes();

  let result = '승인';
  let rejectReasons = [];
  let isManualReview = false;

  // ── [1] 시간대 범위 체크 (08:00 ~ 20:00) ────────────────────
  if (sendHour < 8 || sendHour >= 20) {
    rejectReasons.push(`발송 시간 범위 초과 (허용: 08~20시 / 요청: ${sendHour}시)`);
  }

  // ── [2] 시간대 슬롯 40만 체크 ────────────────────────────────
  if (rejectReasons.length === 0) {
    const slotTotal = await getSlotTotal(sendDatetime);
    const newTotal = slotTotal + sendCount;
    if (newTotal > 400000) {
      rejectReasons.push(
        `시간대 슬롯 초과 (기존 ${slotTotal.toLocaleString()}건 + 요청 ${sendCount.toLocaleString()}건 = ${newTotal.toLocaleString()}건 > 40만)`
      );
    }
  }

  // ── [3] 월요일 18시 이전 체크 ────────────────────────────────
  if (rejectReasons.length === 0 && sendDay === 1) {
    if (sendHour < 18) {
      isManualReview = true;
      result = '수동확인 대기';
    }
  }

  // ── [4] 마수신 동의 키워드 체크 ─────────────────────────────
  if (rejectReasons.length === 0 && !isManualReview && marketingConsent === 'Y') {
    if (!title.includes('(광고)')) {
      rejectReasons.push('제목에 "(광고)" 미포함');
    }
    if (!bodyText.includes('수신거부:알림설정')) {
      rejectReasons.push('본문에 "수신거부:알림설정" 미포함');
    }
  }

  if (rejectReasons.length > 0) {
    result = `반려`;
  }

  // ── 시트 기록 ────────────────────────────────────────────────
  const rowId = Date.now().toString(); // 행 고유 ID (수동 승인/반려 시 매칭용)
  await writeToSheet({
    rowId,
    requestDatetime: requestDatetimeStr,
    requester: user.name,
    sendDatetime: sendDatetimeStr,
    sendCount,
    title,
    body: bodyText,
    marketingConsent,
    result: rejectReasons.length > 0 ? `반려 (${rejectReasons.join(' / ')})` : result,
  });

  // ── 요청자에게 결과 DM ───────────────────────────────────────
  const emoji = result === '승인' ? '✅' : result === '수동확인 대기' ? '⏳' : '❌';
  let resultText = `*${emoji} 번개톡 발송 검토 결과*\n\n`;
  resultText += `*발송 예정:* ${sendDatetimeStr}\n`;
  resultText += `*발송 수량:* ${sendCount.toLocaleString()}건\n`;
  resultText += `*마수신 동의:* ${marketingConsent}\n`;
  resultText += `*검토 결과:* ${emoji} ${result === '수동확인 대기' ? '수동확인 대기 (담당자 검토 후 결과 전달)' : result}`;
  if (rejectReasons.length > 0) {
    resultText += `\n\n*반려 사유:*\n${rejectReasons.map(r => `• ${r}`).join('\n')}`;
  }

  await client.chat.postMessage({
    channel: user.id,
    text: `${emoji} 번개톡 발송 검토 결과: ${result}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: resultText } }],
  });

  // ── 수동확인 필요 시 담당자 DM ──────────────────────────────
  if (isManualReview) {
    const actionPayload = JSON.stringify({
      rowId,
      userId: user.id,
      sendDatetime: sendDatetimeStr,
      sendCount,
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
              `월요일 18시 이전 발송 요청입니다. 검토 후 승인/반려해주세요.\n`,
              `*요청자:* <@${user.id}>`,
              `*발송 예정:* ${sendDatetimeStr}`,
              `*발송 수량:* ${sendCount.toLocaleString()}건`,
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
    await updateSheetResult(data.rowId, '승인 (수동)');

    await client.chat.postMessage({
      channel: data.userId,
      text: `✅ 번개톡 발송 요청이 승인되었습니다.\n발송 예정: ${data.sendDatetime}`,
    });

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `✅ 승인 처리 완료 | 요청자: <@${data.userId}> | ${data.sendDatetime}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *승인 처리 완료*\n요청자: <@${data.userId}> | 발송 예정: ${data.sendDatetime}`,
          },
        },
      ],
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
    await updateSheetResult(data.rowId, '반려 (수동)');

    await client.chat.postMessage({
      channel: data.userId,
      text: `❌ 번개톡 발송 요청이 반려되었습니다.\n발송 예정: ${data.sendDatetime}\n담당자에게 문의해주세요.`,
    });

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `❌ 반려 처리 완료 | 요청자: <@${data.userId}> | ${data.sendDatetime}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `❌ *반려 처리 완료*\n요청자: <@${data.userId}> | 발송 예정: ${data.sendDatetime}`,
          },
        },
      ],
    });
  } catch (error) {
    logger.error(error);
  }
});

// ── Google Sheets 유틸 ────────────────────────────────────────────

// 동일 날짜 + 동일 시간 슬롯의 승인된 발송 수량 합산
async function getSlotTotal(sendDatetime) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:I`, // A=rowId 포함 9열
    });

    const rows = res.data.values || [];
    const targetHour = sendDatetime.getHours();
    const targetDateStr = toDateStr(sendDatetime);

    let total = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      // 컬럼: rowId(0) 요청일시(1) 요청자(2) 발송예정일시(3) 발송수량(4) 제목(5) 본문(6) 마수신(7) 결과(8)
      if (!row[3] || !row[4]) continue;

      const rowDatetime = parseDatetime(row[3]);
      if (!rowDatetime) continue;

      const rowResult = (row[8] || '').trim();
      const rowDateStr = toDateStr(rowDatetime);
      const rowHour = rowDatetime.getHours();

      // 같은 날, 같은 시간 슬롯, 승인된 건만 합산
      if (rowDateStr === targetDateStr && rowHour === targetHour && rowResult.startsWith('승인')) {
        total += parseInt(row[4]) || 0;
      }
    }
    return total;
  } catch (error) {
    console.error('시트 읽기 오류:', error);
    return 0;
  }
}

// 시트에 신규 행 추가
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

// rowId로 검토 결과 컬럼 업데이트
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
          range: `${SHEET_NAME}!I${i + 1}`, // I열 = 검토결과
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
  const match = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!match) return null;
  return new Date(match[1], match[2] - 1, match[3], match[4], match[5]);
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
