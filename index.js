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
        block_id: 'request_type',
        label: { type: 'plain_text', text: '검토 요청 구분' },
        element: {
          type: 'radio_buttons',
          action_id: 'value',
          options: [
            { text: { type: 'plain_text', text: '신규 등록' }, value: 'new' },
            { text: { type: 'plain_text', text: '일정 변경' }, value: 'change' },
          ],
        },
      },
      {
        type: 'input',
        block_id: 'original_date',
        label: { type: 'plain_text', text: '[일정 변경] 기존 발송 날짜' },
        hint: { type: 'plain_text', text: '일정 변경 시에만 입력 | 형식: YYYY-MM-DD' },
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'YYYY-MM-DD' },
        },
      },
      {
        type: 'input',
        block_id: 'original_slots',
        label: { type: 'plain_text', text: '[일정 변경] 기존 시간대' },
        hint: { type: 'plain_text', text: '일정 변경 시에만 입력 | 형식: HH:MM~HH:MM, 수량 (여러 개면 줄바꿈)' },
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          placeholder: { type: 'plain_text', text: '14:00~15:00, 300000\n15:00~16:00, 200000' },
        },
      },
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
          text: '한 줄에 하나씩 입력 | 형식: HH:MM~HH:MM, 수량\n예) 14:00~15:00, 400000',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          placeholder: { type: 'plain_text', text: '14:00~15:00, 400000\n15:00~16:00, 300000' },
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
        label: { type: 'plain_text', text: '마케팅 수신 대상 여부' },
        element: {
          type: 'radio_buttons',
          action_id: 'value',
          options: [
            { text: { type: 'plain_text', text: 'O (수신 대상)' }, value: 'Y' },
            { text: { type: 'plain_text', text: 'X (수신 대상 아님)' }, value: 'N' },
          ],
        },
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: '※ 광고성 메시지 발송일 경우 아래 항목을 반드시 포함해주세요.\n• 메시지 타이틀 내 `(광고)` 표기\n• 메시지 내용 내 `※ 수신거부:알림설정` 표기',
        }],
      },
    ],
  };
}

// ── 모달 제출 처리 ────────────────────────────────────────────────
app.view('bt_modal', async ({ ack, body, view, client, logger }) => {
  const v = view.state.values;
  const user = body.user;

  const requestType = v.request_type.value.selected_option.value;
  const originalDateStr = v.original_date.value?.value?.trim() || '';
  const originalSlotsRaw = v.original_slots.value?.value?.trim() || '';
  const sendDateStr = v.send_date.value.value.trim();
  const slotsRaw = v.slots.value.value.trim();
  const title = v.title.value.value.trim();
  const bodyText = v.body.value.value.trim();
  const marketingConsent = v.marketing_consent.value.selected_option.value;

  // 일정 변경인데 기존 일정 미입력 시 에러
  if (requestType === 'change' && (!originalDateStr || !originalSlotsRaw)) {
    await ack({
      response_action: 'errors',
      errors: {
        ...(!originalDateStr ? { original_date: '일정 변경 시 기존 발송 날짜를 입력해주세요.' } : {}),
        ...(!originalSlotsRaw ? { original_slots: '일정 변경 시 기존 시간대를 입력해주세요.' } : {}),
      },
    });
    return;
  }

  // 날짜 파싱
  const dateMatch = sendDateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) {
    await ack({
      response_action: 'errors',
      errors: { send_date: 'YYYY-MM-DD 형식으로 입력해주세요. (예: 2026-04-10)' },
    });
    return;
  }

  // 슬롯 파싱
  const parsedSlots = parseSlots(slotsRaw);
  if (parsedSlots.error) {
    await ack({
      response_action: 'errors',
      errors: { slots: parsedSlots.error },
    });
    return;
  }

  // 일정 변경 시 기존 시간대 파싱 및 수량 불일치 체크
  if (requestType === 'change') {
    const originalDateParsed = parseDateStr(originalDateStr);
    const originalSlotErrors = {};
    const originalSlotLines = originalSlotsRaw.split('\n').map(l => l.trim()).filter(l => l);

    for (const line of originalSlotLines) {
      const m = line.match(/^(\d{1,2}):(\d{2})~(\d{1,2}):(\d{2})\s*[,\s]\s*([\d,]+)$/);
      if (!m) {
        originalSlotErrors.original_slots = `입력 형식 오류: "${line}"\n올바른 형식: 14:00~15:00, 300000`;
        break;
      }
      const startHour = parseInt(m[1]);
      const startMin = parseInt(m[2]);
      const inputCount = parseInt(m[5].replace(/,/g, ''));
      const registeredCount = await getRegisteredCount(originalDateParsed, startHour, startMin);
      if (registeredCount !== null && registeredCount !== inputCount) {
        originalSlotErrors.original_slots = `수량 불일치: ${String(startHour).padStart(2,'0')}:${String(startMin).padStart(2,'0')}~${m[3].padStart(2,'0')}:${m[4].padStart(2,'0')} 슬롯의 기존 등록 수량과 일치하지 않습니다.`;
        break;
      }
    }

    if (Object.keys(originalSlotErrors).length > 0) {
      await ack({ response_action: 'errors', errors: originalSlotErrors });
      return;
    }
  }

  await ack();

  const requestDatetime = formatDatetime(new Date());
  const sendDate = new Date(dateMatch[1], dateMatch[2] - 1, dateMatch[3]);

  // ── 일정 변경 → 수동 검토 분기 ──────────────────────────────
  if (requestType === 'change') {
    await handleChangeRequest({
      client, user, requestDatetime,
      originalDateStr, originalSlotsRaw,
      sendDateStr, slots: parsedSlots.slots,
      title, bodyText, marketingConsent,
    });
    return;
  }

  // ── 신규 등록 → 기존 검증 로직 ──────────────────────────────
  await handleNewRequest({
    client, user, requestDatetime,
    sendDate, sendDateStr, slots: parsedSlots.slots,
    title, bodyText, marketingConsent,
  });
});

// ── 신규 등록 검증 로직 ───────────────────────────────────────────
async function handleNewRequest({ client, user, requestDatetime, sendDate, sendDateStr, slots, title, bodyText, marketingConsent }) {
  const dayOfWeek = sendDate.getDay();
  const rowId = Date.now().toString();
  const slotResults = [];
  let hasReject = false;
  let hasManualReview = false;

  for (const slot of slots) {
    const { startHour, startMin, count, label } = slot;
    const slotRejects = [];
    let slotManual = false;

    if (startHour < 8 || startHour >= 20) {
      slotRejects.push(`발송 시간 범위 초과 (허용: 08~20시 / 입력: ${label})`);
    }
    if (dayOfWeek === 3 && WED_BLOCKED_HOURS.includes(startHour)) {
      slotRejects.push(`수요일 발송 불가 슬롯 (11·12·13시 / 입력: ${label})`);
    }
    if (slotRejects.length === 0) {
      const existing = await getSlotTotal(sendDate, startHour);
      const newTotal = existing + count;
      if (newTotal > 400000) {
        slotRejects.push(`슬롯 초과 (${startHour}시 슬롯 기존 ${existing.toLocaleString()}건 + 요청 ${count.toLocaleString()}건 = ${newTotal.toLocaleString()}건 > 40만)`);
      }
    }
    if (slotRejects.length === 0 && dayOfWeek === 1 && startHour < 18) {
      slotManual = true;
      hasManualReview = true;
    }
    if (slotRejects.length === 0 && !slotManual && marketingConsent === 'Y') {
      if (!title.includes('(광고)')) slotRejects.push('제목에 "(광고)" 미포함');
      if (!bodyText.includes('수신거부') || !bodyText.includes('알림설정')) slotRejects.push('본문에 "수신거부:알림설정" 미포함');
    }

    const slotResult = slotRejects.length > 0 ? `반려 (${slotRejects.join(' / ')})` : slotManual ? '수동확인 대기' : '승인';
    if (slotRejects.length > 0) hasReject = true;

    slotResults.push({ label, startHour, startMin, count, result: slotResult, rejects: slotRejects, manual: slotManual });

    await writeToSheet({
      rowId: `${rowId}_${startHour}_${startMin}`,
      requestDatetime, requester: user.name,
      sendDatetime: `${sendDateStr} ${String(startHour).padStart(2,'0')}:${String(startMin).padStart(2,'0')}`,
      sendCount: count, title, body: bodyText, marketingConsent, result: slotResult,
    });
  }

  // 요청자 DM
  const overallEmoji = hasReject ? '❌' : hasManualReview ? '⏳' : '✅';
  const overallLabel = hasReject ? '일부 반려 포함' : hasManualReview ? '일부 수동확인 대기' : '전체 승인';
  let resultText = `*${overallEmoji} 번개톡 발송 검토 결과*\n\n*발송 예정 날짜:* ${sendDateStr}\n*마수신 동의:* ${marketingConsent}\n\n*시간대별 결과:*\n`;
  for (const slot of slotResults) {
    const e = slot.result === '승인' ? '✅' : slot.result === '수동확인 대기' ? '⏳' : '❌';
    resultText += `${e} *${slot.label}* | ${slot.count.toLocaleString()}건 | ${slot.result}\n`;
  }
  await client.chat.postMessage({
    channel: user.id,
    text: `${overallEmoji} 번개톡 검토 결과: ${overallLabel}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: resultText } }],
  });

  // 수동확인 담당자 DM
  const manualSlots = slotResults.filter(s => s.manual);
  if (manualSlots.length > 0) {
    await sendManualReviewDM({
      client, user, rowId, sendDateStr, manualSlots,
      title, bodyText, marketingConsent, isChange: false,
    });
  }
}

// ── 일정 변경 수동 검토 요청 ─────────────────────────────────────
async function handleChangeRequest({ client, user, requestDatetime, originalDateStr, originalSlotsRaw, sendDateStr, slots, title, bodyText, marketingConsent }) {
  const rowId = `change_${Date.now()}`;

  // 변경 요청 시트 기록 (수동확인 대기)
  for (const slot of slots) {
    await writeToSheet({
      rowId: `${rowId}_${slot.startHour}_${slot.startMin}`,
      requestDatetime, requester: user.name,
      sendDatetime: `${sendDateStr} ${String(slot.startHour).padStart(2,'0')}:${String(slot.startMin).padStart(2,'0')}`,
      sendCount: slot.count, title, body: bodyText, marketingConsent,
      result: '수동확인 대기 (일정 변경)',
    });
  }

  // 요청자 접수 확인 DM
  await client.chat.postMessage({
    channel: user.id,
    text: '⏳ 일정 변경 요청이 접수되었습니다. 담당자 검토 후 결과를 안내드립니다.',
    blocks: [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*⏳ 일정 변경 요청 접수*\n\n*기존 일정:* ${originalDateStr} | ${originalSlotsRaw.replace(/\n/g, ', ')}\n*변경 일정:* ${sendDateStr} | ${slots.map(s => s.label).join(', ')}\n\n담당자 검토 후 결과를 안내드립니다.`,
      },
    }],
  });

  // 담당자 DM (승인/반려 버튼)
  const actionPayload = JSON.stringify({
    rowId, userId: user.id, userName: user.name,
    originalDateStr, originalSlotsRaw,
    sendDateStr,
    slots: slots.map(s => ({ label: s.label, startHour: s.startHour, startMin: s.startMin, count: s.count })),
    title, bodyText, marketingConsent,
  });

  const slotSummary = slots.map(s => `• ${s.label} | ${s.count.toLocaleString()}건`).join('\n');

  await client.chat.postMessage({
    channel: REVIEWER_SLACK_ID,
    text: '🔄 번개톡 일정 변경 검토 요청',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '*🔄 번개톡 일정 변경 검토 요청*\n',
            `*요청자:* <@${user.id}>`,
            `*기존 일정:* ${originalDateStr} | ${originalSlotsRaw.replace(/\n/g, ', ')}`,
            `*변경 일정:* ${sendDateStr}`,
            `*변경 슬롯:*\n${slotSummary}`,
            `*제목:* ${title}`,
            `*본문:* ${bodyText.substring(0, 100)}${bodyText.length > 100 ? '...' : ''}`,
            `*마수신 동의:* ${marketingConsent}`,
          ].join('\n'),
        },
      },
      {
        type: 'actions',
        block_id: 'change_review_actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ 승인' },
            style: 'primary',
            action_id: 'change_approve',
            value: actionPayload,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ 반려' },
            style: 'danger',
            action_id: 'change_reject_open',
            value: actionPayload,
          },
        ],
      },
    ],
  });
}

// ── 일정 변경 승인 ────────────────────────────────────────────────
app.action('change_approve', async ({ ack, body, action, client, logger }) => {
  await ack();
  try {
    const data = JSON.parse(action.value);

    // 신규 슬롯 검증 먼저
    const sendDate = parseDateStr(data.sendDateStr);
    const dayOfWeek = sendDate.getDay();
    const slotResults = [];
    let hasReject = false;

    for (const slot of data.slots) {
      const { startHour, startMin, count, label } = slot;
      const slotRejects = [];

      if (startHour < 8 || startHour >= 20) slotRejects.push(`발송 시간 범위 초과 (${label})`);
      if (dayOfWeek === 3 && WED_BLOCKED_HOURS.includes(startHour)) slotRejects.push(`수요일 발송 불가 슬롯 (${label})`);
      if (slotRejects.length === 0) {
        const existing = await getSlotTotal(sendDate, startHour);
        const newTotal = existing + count;
        if (newTotal > 400000) slotRejects.push(`슬롯 초과 (${startHour}시 ${existing.toLocaleString()}+${count.toLocaleString()}=${newTotal.toLocaleString()} > 40만)`);
      }
      if (slotRejects.length === 0 && data.marketingConsent === 'Y') {
        if (!data.title.includes('(광고)')) slotRejects.push('제목에 "(광고)" 미포함');
        if (!data.bodyText.includes('수신거부') || !data.bodyText.includes('알림설정')) slotRejects.push('본문에 "수신거부:알림설정" 미포함');
      }

      const slotResult = slotRejects.length > 0 ? `반려 (${slotRejects.join(' / ')})` : '승인 (변경)';
      if (slotRejects.length > 0) hasReject = true;

      slotResults.push({ label, startHour, startMin, count, result: slotResult, rejects: slotRejects });
    }

    // 검증 결과에 따라 원본 취소 여부 결정
    const originalDate = parseDateStr(data.originalDateStr);
    const originalSlotLines = data.originalSlotsRaw.split('\n').map(l => l.trim()).filter(l => l);

    for (const slot of slotResults) {
      if (slot.result === '승인 (변경)') {
        // 승인된 슬롯만 원본 취소 (수량 포함 형식: HH:MM~HH:MM, 수량)
        for (const slotLine of originalSlotLines) {
          const m = slotLine.match(/^(\d{1,2}):(\d{2})~(\d{1,2}):(\d{2})\s*[,\s]\s*[\d,]+$/);
          if (m) await cancelSheetSlot(originalDate, parseInt(m[1]), parseInt(m[2]));
        }
      }
      // change_ 행 결과 업데이트
      await updateSheetResult(`${data.rowId}_${slot.startHour}_${slot.startMin}`, slot.result);
    }

    // 요청자 결과 DM
    const overallEmoji = hasReject ? '❌' : '✅';
    let resultText = `*${overallEmoji} 일정 변경 검토 결과*\n\n*변경 일정:* ${data.sendDateStr}\n\n*시간대별 결과:*\n`;
    for (const s of slotResults) {
      const e = s.result.startsWith('승인') ? '✅' : '❌';
      resultText += `${e} *${s.label}* | ${s.count.toLocaleString()}건 | ${s.result}\n`;
    }
    if (hasReject) {
      resultText += `\n반려된 슬롯이 있어 해당 기존 일정은 유지됩니다.`;
    }
    await client.chat.postMessage({ channel: data.userId, text: `${overallEmoji} 일정 변경 결과 안내`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: resultText } }] });

    // 담당자 메시지 업데이트
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts,
      text: `${overallEmoji} 일정 변경 처리 완료`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${overallEmoji} *일정 변경 처리 완료*\n요청자: <@${data.userId}> | ${data.sendDateStr}${hasReject ? ' (일부 반려)' : ''}` } }],
    });
  } catch (error) {
    logger.error(error);
  }
});

// ── 일정 변경 반려 버튼 → 사유 입력 모달 ────────────────────────
app.action('change_reject_open', async ({ ack, body, action, client, logger }) => {
  await ack();
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'change_reject_modal',
        private_metadata: JSON.stringify({
          payload: action.value,
          channelId: body.channel.id,
          messageTs: body.message.ts,
        }),
        title: { type: 'plain_text', text: '반려 사유 입력' },
        submit: { type: 'plain_text', text: '반려 처리' },
        close: { type: 'plain_text', text: '취소' },
        blocks: [
          {
            type: 'input',
            block_id: 'reject_reason',
            label: { type: 'plain_text', text: '반려 사유' },
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              multiline: true,
              placeholder: { type: 'plain_text', text: '반려 사유를 입력해주세요.' },
            },
          },
        ],
      },
    });
  } catch (error) {
    logger.error(error);
  }
});

// ── 일정 변경 반려 처리 ──────────────────────────────────────────
app.view('change_reject_modal', async ({ ack, body, view, client, logger }) => {
  await ack();
  try {
    const meta = JSON.parse(view.private_metadata);
    const data = JSON.parse(meta.payload);
    const rejectReason = view.state.values.reject_reason.value.value.trim();

    // 시트 결과 업데이트
    for (const slot of data.slots) {
      await updateSheetResult(`${data.rowId}_${slot.startHour}_${slot.startMin}`, `반려 (변경) - ${rejectReason}`);
    }

    // 요청자 반려 알림 DM
    await client.chat.postMessage({
      channel: data.userId,
      text: '❌ 일정 변경 요청이 반려되었습니다.',
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*❌ 일정 변경 요청 반려*\n\n*기존 일정 유지:* ${data.originalDateStr} | ${data.originalSlotsRaw.replace(/\n/g, ', ')}\n*반려 사유:* ${rejectReason}\n\n문의사항은 담당자에게 연락해주세요.`,
        },
      }],
    });

    // 담당자 메시지 업데이트
    await client.chat.update({
      channel: meta.channelId, ts: meta.messageTs,
      text: '❌ 일정 변경 반려 완료',
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `❌ *일정 변경 반려 완료*\n요청자: <@${data.userId}> | 사유: ${rejectReason}` },
      }],
    });
  } catch (error) {
    logger.error(error);
  }
});

// ── 신규 수동확인 담당자 DM 공통 함수 ───────────────────────────
async function sendManualReviewDM({ client, user, rowId, sendDateStr, manualSlots, title, bodyText, marketingConsent }) {
  const manualDetail = manualSlots.map(s => `• ${s.label} | ${s.count.toLocaleString()}건`).join('\n');
  const actionPayload = JSON.stringify({
    rowId, userId: user.id, sendDateStr,
    manualSlots: manualSlots.map(s => ({ label: s.label, startHour: s.startHour, startMin: s.startMin, count: s.count })),
    title, bodyText, marketingConsent,
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
            type: 'button', text: { type: 'plain_text', text: '✅ 승인' }, style: 'primary',
            action_id: 'manual_approve', value: actionPayload,
          },
          {
            type: 'button', text: { type: 'plain_text', text: '❌ 반려' }, style: 'danger',
            action_id: 'manual_reject', value: actionPayload,
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

// ── 신규 수동 승인 ────────────────────────────────────────────────
app.action('manual_approve', async ({ ack, body, action, client, logger }) => {
  await ack();
  try {
    const data = JSON.parse(action.value);
    const slotLabels = data.manualSlots.map(s => s.label).join(', ');
    for (const slot of data.manualSlots) {
      await updateSheetResult(`${data.rowId}_${slot.startHour}_${slot.startMin}`, '승인 (수동)');
    }
    await client.chat.postMessage({ channel: data.userId, text: `✅ 번개톡 발송 요청이 승인되었습니다.\n발송 예정: ${data.sendDateStr} | ${slotLabels}` });
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts, text: '✅ 승인 처리 완료',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✅ *승인 처리 완료*\n요청자: <@${data.userId}> | ${data.sendDateStr} ${slotLabels}` } }],
    });
  } catch (error) { logger.error(error); }
});

// ── 신규 수동 반려 ────────────────────────────────────────────────
app.action('manual_reject', async ({ ack, body, action, client, logger }) => {
  await ack();
  try {
    const data = JSON.parse(action.value);
    const slotLabels = data.manualSlots.map(s => s.label).join(', ');
    for (const slot of data.manualSlots) {
      await updateSheetResult(`${data.rowId}_${slot.startHour}_${slot.startMin}`, '반려 (수동)');
    }
    await client.chat.postMessage({ channel: data.userId, text: `❌ 번개톡 발송 요청이 반려되었습니다.\n발송 예정: ${data.sendDateStr} | ${slotLabels}\n담당자에게 문의해주세요.` });
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts, text: '❌ 반려 처리 완료',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `❌ *반려 처리 완료*\n요청자: <@${data.userId}> | ${data.sendDateStr} ${slotLabels}` } }],
    });
  } catch (error) { logger.error(error); }
});

// ── 슬롯 텍스트 파싱 ─────────────────────────────────────────────
function parseSlots(raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return { error: '시간대를 1개 이상 입력해주세요.' };

  const slots = [];
  for (const line of lines) {
    const match = line.match(/^(\d{1,2}):(\d{2})~(\d{1,2}):(\d{2})\s*[,\s]\s*([\d,]+)$/);
    if (!match) return { error: `입력 형식 오류: "${line}"\n올바른 형식: 14:00~15:00, 400000` };

    const startHour = parseInt(match[1]);
    const startMin = parseInt(match[2]);
    const endHour = parseInt(match[3]);
    const endMin = parseInt(match[4]);
    const countRaw = match[5].replace(/,/g, '');
    const count = parseInt(countRaw);
    if (isNaN(count) || count <= 0) {
      return { error: `수량이 올바르지 않습니다: "${line}"
0보다 큰 숫자를 입력해주세요.` };
    }

    const startTotal = startHour * 60 + startMin;
    const endTotal = endHour * 60 + endMin;
    if (endTotal - startTotal !== 60) {
      return { error: `발송 범위는 정확히 1시간이어야 합니다: "${line}"\n예) 14:00~15:00, 14:30~15:30` };
    }

    const label = `${String(startHour).padStart(2,'0')}:${String(startMin).padStart(2,'0')}~${String(endHour).padStart(2,'0')}:${String(endMin).padStart(2,'0')}`;
    slots.push({ startHour, startMin, endHour, endMin, count, label });
  }
  return { slots };
}

// ── Google Sheets 유틸 ────────────────────────────────────────────

// 기존 등록된 특정 슬롯의 수량 조회 (일정 변경 수량 검증용)
async function getRegisteredCount(sendDate, targetHour, targetMin) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:I` });
    const rows = res.data.values || [];
    const targetDateStr = toDateStr(sendDate);
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[3] || !row[4]) continue;
      const rowDatetime = parseDatetime(row[3]);
      if (!rowDatetime) continue;
      if (toDateStr(rowDatetime) !== targetDateStr) continue;
      if (rowDatetime.getHours() !== targetHour) continue;
      if (rowDatetime.getMinutes() !== targetMin) continue;
      const rowResult = (row[8] || '').trim();
      if (rowResult.startsWith('승인') || rowResult.includes('수동확인 대기')) {
        return parseInt(row[4]) || null;
      }
    }
    return null; // 등록된 건 없으면 null (체크 스킵)
  } catch (error) {
    console.error('수량 조회 오류:', error);
    return null;
  }
}

async function getSlotTotal(sendDate, targetHour) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:I` });
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
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:I`, valueInputOption: 'USER_ENTERED',
      resource: { values: [[data.rowId, data.requestDatetime, data.requester, data.sendDatetime, data.sendCount, data.title, data.body, data.marketingConsent, data.result]] },
    });
  } catch (error) { console.error('시트 쓰기 오류:', error); }
}

async function updateSheetResult(rowId, newResult) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:I` });
    const rows = res.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === rowId) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!I${i + 1}`, valueInputOption: 'USER_ENTERED',
          resource: { values: [[newResult]] },
        });
        return;
      }
    }
  } catch (error) { console.error('시트 업데이트 오류:', error); }
}

// 기존 슬롯 취소 처리 (일정 변경 승인 시)
async function cancelSheetSlot(sendDate, targetHour, targetMin) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:I` });
    const rows = res.data.values || [];
    const targetDateStr = toDateStr(sendDate);
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[3]) continue;
      const rowDatetime = parseDatetime(row[3]);
      if (!rowDatetime) continue;
      if (toDateStr(rowDatetime) !== targetDateStr) continue;
      if (rowDatetime.getHours() !== targetHour) continue;
      if (rowDatetime.getMinutes() !== targetMin) continue;
      const currentResult = (row[8] || '').trim();
      if (currentResult.startsWith('승인')) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!I${i + 1}`, valueInputOption: 'USER_ENTERED',
          resource: { values: [['취소 (일정 변경)']] },
        });
      }
    }
  } catch (error) { console.error('슬롯 취소 오류:', error); }
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

  try {
    await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1` });
    console.log('✅ Google Sheets 인증 완료');
  } catch (e) {
    console.warn('⚠️ Google Sheets 워밍업 실패 (무시):', e.message);
  }
})();
