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
        label: { type: 'plain_text', text: '요청 유형' },
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
        label: { type: 'plain_text', text: '시간대 입력' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          placeholder: { type: 'plain_text', text: '14:00~15:00, 400000' },
        },
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: '*신규 등록 시*\n형식: `HH:MM~HH:MM, 수량`\n예) `14:00~15:00, 400000`\n\n*일정 변경 시* (기존 → 변경)\n형식: `HH:MM~HH:MM, 수량 → HH:MM~HH:MM, 수량`\n예) `14:00~15:00, 300000 → 15:00~16:00, 300000`\n구분자는 `→`, `->`, `>` 모두 사용 가능',
        }],
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
        label: { type: 'plain_text', text: '광고성 메시지 여부' },
        element: {
          type: 'radio_buttons',
          action_id: 'value',
          options: [
            { text: { type: 'plain_text', text: 'O' }, value: 'Y' },
            { text: { type: 'plain_text', text: 'X' }, value: 'N' },
          ],
        },
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: '※ 광고성 메시지 발송일 경우 아래 항목을 반드시 포함해 주세요.\n• 메시지 타이틀 내 `(광고)` 표기\n• 메시지 내용 내 `※ 수신거부:알림설정` 표기',
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
  const sendDateStr = v.send_date.value.value.trim();
  const slotsRaw = v.slots.value.value.trim();
  const title = v.title.value.value.trim();
  const bodyText = v.body.value.value.trim();
  const marketingConsent = v.marketing_consent.value.selected_option.value;

  // 일정 변경인데 기존 날짜 미입력 시 에러
  if (requestType === 'change' && !originalDateStr) {
    await ack({
      response_action: 'errors',
      errors: { original_date: '일정 변경 시 기존 발송 날짜를 입력해주세요.' },
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

  // 슬롯 파싱 (신규: 단순 파싱 / 변경: 매핑 파싱)
  let parsedSlots, parsedMappings;
  if (requestType === 'change') {
    const mappingResult = parseSlotMappings(slotsRaw);
    if (mappingResult.error) {
      await ack({ response_action: 'errors', errors: { slots: mappingResult.error } });
      return;
    }
    parsedMappings = mappingResult.mappings;
    parsedSlots = { slots: parsedMappings.map(m => m.newSlot) };
  } else {
    parsedSlots = parseSlots(slotsRaw);
    if (parsedSlots.error) {
      await ack({ response_action: 'errors', errors: { slots: parsedSlots.error } });
      return;
    }
  }

  // 일정 변경 시 기존 슬롯 수량 불일치 체크
  if (requestType === 'change') {
    const originalDateParsed = parseDateStr(originalDateStr);
    for (const mapping of parsedMappings) {
      const { oldSlot } = mapping;
      const registeredCount = await getRegisteredCount(originalDateParsed, oldSlot.startHour, oldSlot.startMin);
      if (registeredCount !== null && registeredCount !== oldSlot.count) {
        await ack({ response_action: 'errors', errors: { slots: `수량 불일치: ${oldSlot.label} 슬롯의 기존 등록 수량과 일치하지 않습니다.` } });
        return;
      }
    }
  }

  await ack();

  const requestDatetime = formatDatetime(new Date());
  const sendDate = new Date(dateMatch[1], dateMatch[2] - 1, dateMatch[3]);

  // ── 일정 변경 → 수동 검토 분기 ──────────────────────────────
  if (requestType === 'change') {
    await handleChangeRequest({
      client, user, requestDatetime,
      originalDateStr, mappings: parsedMappings,
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

    if (startHour < 8 || startHour > 20) {
      slotRejects.push(`발송 시간 범위 초과 (허용: 08~21시 / 입력: ${label})`);
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
async function handleChangeRequest({ client, user, requestDatetime, originalDateStr, mappings, sendDateStr, slots, title, bodyText, marketingConsent }) {
  const rowId = `change_${Date.now()}`;

  // 변경 요청 시트 기록 (수동확인 대기) - 매핑 기준으로 기록
  for (const mapping of mappings) {
    const slot = mapping.newSlot;
    await writeToSheet({
      rowId: `${rowId}_${slot.startHour}_${slot.startMin}`,
      requestDatetime, requester: user.name,
      sendDatetime: `${sendDateStr} ${String(slot.startHour).padStart(2,'0')}:${String(slot.startMin).padStart(2,'0')}`,
      sendCount: slot.count, title, body: bodyText, marketingConsent,
      result: '수동확인 대기 (일정 변경)',
    });
  }

  // 매핑 요약 텍스트
  const mappingSummary = mappings.map(m => `• ${m.oldSlot.label} → ${m.newSlot.label} | ${m.newSlot.count.toLocaleString()}건`).join('\n');

  // 요청자 접수 확인 DM
  await client.chat.postMessage({
    channel: user.id,
    text: '⏳ 일정 변경 요청이 접수되었습니다. 담당자 검토 후 결과를 안내드립니다.',
    blocks: [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*⏳ 일정 변경 요청 접수*\n\n*기존 날짜:* ${originalDateStr}\n*변경 날짜:* ${sendDateStr}\n\n*슬롯 매핑:*\n${mappingSummary}\n\n담당자 검토 후 결과를 안내드립니다.`,
      },
    }],
  });

  // mappings를 JSON으로 직렬화해서 페이로드에 포함
  const mappingsJson = mappings.map(m => ({
    oldSlot: { label: m.oldSlot.label, startHour: m.oldSlot.startHour, startMin: m.oldSlot.startMin, count: m.oldSlot.count },
    newSlot: { label: m.newSlot.label, startHour: m.newSlot.startHour, startMin: m.newSlot.startMin, count: m.newSlot.count },
  }));

  const headerBlocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '*🔄 번개톡 일정 변경 검토 요청*\n',
          `*요청자:* <@${user.id}>`,
          `*기존 날짜:* ${originalDateStr}`,
          `*변경 날짜:* ${sendDateStr}`,
          `*슬롯 매핑:*\n${mappingSummary}`,
          `*제목:* ${title}`,
          `*본문:* ${bodyText.substring(0, 100)}${bodyText.length > 100 ? '...' : ''}`,
          `*마수신 동의:* ${marketingConsent}`,
        ].join('\n'),
      },
    },
    { type: 'divider' },
  ];

  const allSlots = mappings.map(m => ({ label: m.newSlot.label, startHour: m.newSlot.startHour, startMin: m.newSlot.startMin, count: m.newSlot.count }));
  const baseData = {
    rowId, userId: user.id, userName: user.name,
    originalDateStr, mappingsJson,
    sendDateStr, title, bodyText, marketingConsent,
    allSlots,
  };
  const slotBlocks = buildSlotBlocks(baseData, {});

  await client.chat.postMessage({
    channel: REVIEWER_SLACK_ID,
    text: '🔄 번개톡 일정 변경 검토 요청',
    blocks: [...headerBlocks, ...slotBlocks],
  });
}

// ── 슬롯 블록 빌더 (처리 결과 맵 반영) ──────────────────────────
// statusMap: { "startHour_startMin": "승인 (변경)" | "반려 ..." | null }
function buildSlotBlocks(baseData, statusMap) {
  const blocks = [];
  for (const slot of baseData.allSlots) {
    const key = `${slot.startHour}_${slot.startMin}`;
    const status = statusMap[key] || null;
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${slot.label}* | ${slot.count.toLocaleString()}건${status ? `  →  ${status}` : ''}` },
    });
    if (!status) {
      const slotPayload = JSON.stringify({
        ...baseData,
        slot: { label: slot.label, startHour: slot.startHour, startMin: slot.startMin, count: slot.count },
      });
      blocks.push({
        type: 'actions',
        block_id: `slot_actions_${key}`,
        elements: [
          { type: 'button', text: { type: 'plain_text', text: '✅ 승인' }, style: 'primary', action_id: 'change_slot_approve', value: slotPayload },
          { type: 'button', text: { type: 'plain_text', text: '❌ 반려' }, style: 'danger', action_id: 'change_slot_reject_open', value: slotPayload },
        ],
      });
    }
  }
  return blocks;
}

// ── 시트에서 슬롯 상태 맵 읽기 ──────────────────────────────────
async function getSlotStatusMap(rowId, allSlots) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:I` });
    const rows = res.data.values || [];
    const statusMap = {};
    for (const slot of allSlots) {
      const key = `${slot.startHour}_${slot.startMin}`;
      const targetRowId = `${rowId}_${slot.startHour}_${slot.startMin}`;
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] === targetRowId) {
          const result = (rows[i][8] || '').trim();
          if (result !== '수동확인 대기 (일정 변경)') {
            statusMap[key] = result;
          }
          break;
        }
      }
    }
    return statusMap;
  } catch (e) {
    return {};
  }
}

// ── 슬롯별 승인 ──────────────────────────────────────────────────
app.action('change_slot_approve', async ({ ack, body, action, client, logger }) => {
  await ack();
  try {
    const data = JSON.parse(action.value);
    const { slot } = data;
    const { startHour, startMin, count, label } = slot;

    // 신규 슬롯 검증
    const sendDate = parseDateStr(data.sendDateStr);
    const dayOfWeek = sendDate.getDay();
    const slotRejects = [];

    if (startHour < 8 || startHour > 20) slotRejects.push(`발송 시간 범위 초과 (${label})`);
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

    let finalResult;
    if (slotRejects.length > 0) {
      finalResult = `반려 (${slotRejects.join(' / ')})`;
      await updateSheetResult(`${data.rowId}_${startHour}_${startMin}`, finalResult);
      await client.chat.postMessage({
        channel: data.userId,
        text: `❌ 일정 변경 반려: ${label}`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*❌ 일정 변경 반려*
*슬롯:* ${label} | ${count.toLocaleString()}건
*사유:* ${slotRejects.join(', ')}
기존 일정이 유지됩니다.` } }],
      });
    } else {
      finalResult = '승인 (변경)';
      const originalDate = parseDateStr(data.originalDateStr);
      const mapping = (data.mappingsJson || []).find(m => m.newSlot.startHour === startHour && m.newSlot.startMin === startMin);
      if (mapping) {
        await cancelSheetSlot(originalDate, mapping.oldSlot.startHour, mapping.oldSlot.startMin);
      }
      await updateSheetResult(`${data.rowId}_${startHour}_${startMin}`, finalResult);
      await client.chat.postMessage({
        channel: data.userId,
        text: `✅ 일정 변경 승인: ${label}`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*✅ 일정 변경 승인*
*슬롯:* ${label} | ${count.toLocaleString()}건
*변경 일정:* ${data.sendDateStr}` } }],
      });
    }

    // 전체 메시지 재조립 (처리된 슬롯은 결과 표시, 미처리 슬롯은 버튼 유지)
    const statusMap = await getSlotStatusMap(data.rowId, data.allSlots);
    const headerBlocks = buildChangeHeaderBlocks(data);
    const slotBlocks = buildSlotBlocks(data, statusMap);
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts,
      text: '🔄 번개톡 일정 변경 검토 요청',
      blocks: [...headerBlocks, ...slotBlocks],
    });
  } catch (error) {
    logger.error(error);
  }
});

// ── 슬롯별 반려 버튼 → 사유 입력 모달 ───────────────────────────
app.action('change_slot_reject_open', async ({ ack, body, action, client, logger }) => {
  await ack();
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'change_slot_reject_modal',
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

// ── 슬롯별 반려 처리 ─────────────────────────────────────────────
app.view('change_slot_reject_modal', async ({ ack, body, view, client, logger }) => {
  await ack();
  try {
    const meta = JSON.parse(view.private_metadata);
    const data = JSON.parse(meta.payload);
    const { slot } = data;
    const rejectReason = view.state.values.reject_reason.value.value.trim();

    await updateSheetResult(`${data.rowId}_${slot.startHour}_${slot.startMin}`, `반려 (변경) - ${rejectReason}`);

    await client.chat.postMessage({
      channel: data.userId,
      text: `❌ 일정 변경 반려: ${slot.label}`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*❌ 일정 변경 반려*
*슬롯:* ${slot.label} | ${slot.count.toLocaleString()}건
*반려 사유:* ${rejectReason}
기존 일정이 유지됩니다.

문의사항은 담당자에게 연락해주세요.` } }],
    });

    // 전체 메시지 재조립
    const statusMap = await getSlotStatusMap(data.rowId, data.allSlots);
    const headerBlocks = buildChangeHeaderBlocks(data);
    const slotBlocks = buildSlotBlocks(data, statusMap);
    await client.chat.update({
      channel: meta.channelId, ts: meta.messageTs,
      text: '🔄 번개톡 일정 변경 검토 요청',
      blocks: [...headerBlocks, ...slotBlocks],
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
            action_id: 'manual_reject_open', value: actionPayload,
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

// ── 신규 수동 반려 버튼 → 사유 입력 모달 ───────────────────────
app.action('manual_reject_open', async ({ ack, body, action, client, logger }) => {
  await ack();
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'manual_reject_modal',
        private_metadata: JSON.stringify({
          payload: action.value,
          channelId: body.channel.id,
          messageTs: body.message.ts,
        }),
        title: { type: 'plain_text', text: '반려 사유 입력' },
        submit: { type: 'plain_text', text: '반려 처리' },
        close: { type: 'plain_text', text: '취소' },
        blocks: [{
          type: 'input',
          block_id: 'reject_reason',
          label: { type: 'plain_text', text: '반려 사유' },
          element: {
            type: 'plain_text_input',
            action_id: 'value',
            multiline: true,
            placeholder: { type: 'plain_text', text: '반려 사유를 입력해주세요.' },
          },
        }],
      },
    });
  } catch (error) { logger.error(error); }
});

// ── 신규 수동 반려 처리 ───────────────────────────────────────────
app.view('manual_reject_modal', async ({ ack, body, view, client, logger }) => {
  await ack();
  try {
    const meta = JSON.parse(view.private_metadata);
    const data = JSON.parse(meta.payload);
    const rejectReason = view.state.values.reject_reason.value.value.trim();
    const slotLabels = data.manualSlots.map(s => s.label).join(', ');

    for (const slot of data.manualSlots) {
      await updateSheetResult(`${data.rowId}_${slot.startHour}_${slot.startMin}`, `반려 (수동) - ${rejectReason}`);
    }
    await client.chat.postMessage({
      channel: data.userId,
      text: `❌ 번개톡 발송 요청이 반려되었습니다.`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*❌ 번개톡 발송 요청 반려*\n*발송 예정:* ${data.sendDateStr} | ${slotLabels}\n*반려 사유:* ${rejectReason}\n\n담당자에게 문의해주세요.` } }],
    });
    await client.chat.update({
      channel: meta.channelId, ts: meta.messageTs, text: '❌ 반려 처리 완료',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `❌ *반려 처리 완료*\n요청자: <@${data.userId}> | ${data.sendDateStr} ${slotLabels}\n사유: ${rejectReason}` } }],
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

// ── 슬롯 매핑 파싱 (일정 변경용) ───────────────────────────────
// 형식: HH:MM~HH:MM, 수량 → HH:MM~HH:MM, 수량 (→, ->, > 모두 허용)
function parseSlotMappings(raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return { error: '시간대 매핑을 1개 이상 입력해주세요.' };

  const mappings = [];
  const slotPattern = /^(\d{1,2}):(\d{2})~(\d{1,2}):(\d{2})\s*[,\s]\s*([\d,]+)$/;

  for (const line of lines) {
    const parts = line.split(/\s*(→|->|>)\s*/);
    if (parts.length < 3) {
      return { error: `구분자(→, ->, >) 없음: "${line}"\n예) 14:00~15:00, 300000 → 15:00~16:00, 300000` };
    }

    const oldPart = parts[0].trim();
    const newPart = parts[parts.length - 1].trim();

    const oldMatch = oldPart.match(slotPattern);
    if (!oldMatch) return { error: `기존 슬롯 형식 오류: "${oldPart}"\n올바른 형식: 14:00~15:00, 300000` };

    const newMatch = newPart.match(slotPattern);
    if (!newMatch) return { error: `변경 슬롯 형식 오류: "${newPart}"\n올바른 형식: 14:00~15:00, 300000` };

    // 1시간 범위 체크
    const oldStart = parseInt(oldMatch[1]) * 60 + parseInt(oldMatch[2]);
    const oldEnd = parseInt(oldMatch[3]) * 60 + parseInt(oldMatch[4]);
    if (oldEnd - oldStart !== 60) return { error: `기존 슬롯 범위는 정확히 1시간이어야 합니다: "${oldPart}"` };

    const newStart = parseInt(newMatch[1]) * 60 + parseInt(newMatch[2]);
    const newEnd = parseInt(newMatch[3]) * 60 + parseInt(newMatch[4]);
    if (newEnd - newStart !== 60) return { error: `변경 슬롯 범위는 정확히 1시간이어야 합니다: "${newPart}"` };

    // 수량 유효성 체크
    const oldCount = parseInt(oldMatch[5].replace(/,/g, ''));
    const newCount = parseInt(newMatch[5].replace(/,/g, ''));
    if (isNaN(oldCount) || oldCount <= 0) return { error: `기존 슬롯 수량 오류: "${oldPart}"` };
    if (isNaN(newCount) || newCount <= 0) return { error: `변경 슬롯 수량 오류: "${newPart}"` };

    const makeLabel = (m) => `${String(parseInt(m[1])).padStart(2,'0')}:${m[2]}~${String(parseInt(m[3])).padStart(2,'0')}:${m[4]}`;

    mappings.push({
      oldSlot: { label: makeLabel(oldMatch), startHour: parseInt(oldMatch[1]), startMin: parseInt(oldMatch[2]), count: oldCount },
      newSlot: { label: makeLabel(newMatch), startHour: parseInt(newMatch[1]), startMin: parseInt(newMatch[2]), count: newCount },
    });
  }
  return { mappings };
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

// ── /bt-status 커맨드 → 날짜별 슬롯 현황 ──────────────────────
app.command('/bt-status', async ({ command, ack, client, logger }) => {
  await ack();
  try {
    const dateStr = command.text.trim();
    const dateMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);

    if (!dateMatch) {
      await client.chat.postMessage({
        channel: command.user_id,
        text: '❌ 날짜 형식 오류\n올바른 형식: `/bt-status YYYY-MM-DD`\n예) `/bt-status 2026-04-29`',
      });
      return;
    }

    const targetDate = new Date(dateMatch[1], dateMatch[2] - 1, dateMatch[3]);
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    const dayName = dayNames[targetDate.getDay()];

    // 시트에서 해당 날짜 승인 건 집계
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:I`,
    });
    const rows = res.data.values || [];
    const targetDateStr = toDateStr(targetDate);
    const slotMap = {};

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[3] || !row[4]) continue;
      const rowDatetime = parseDatetime(row[3]);
      if (!rowDatetime) continue;
      if (toDateStr(rowDatetime) !== targetDateStr) continue;
      const rowResult = (row[8] || '').trim();
      if (!rowResult.startsWith('승인')) continue;
      const h = rowDatetime.getHours();
      slotMap[h] = (slotMap[h] || 0) + (parseInt(row[4]) || 0);
    }

    // 슬롯 현황 텍스트 생성
    const MAX = 400000;
    const BAR_LEN = 10;
    let statusText = `*📊 ${dateStr} (${dayName}) 슬롯 현황*

`;

    const VALID_HOURS = Array.from({ length: 13 }, (_, i) => i + 8);
    for (const h of VALID_HOURS) {
      const used = slotMap[h] || 0;
      const remaining = MAX - used;
      const filled = Math.round((used / MAX) * BAR_LEN);
      const bar = '█'.repeat(filled) + '░'.repeat(BAR_LEN - filled);
      const usedStr = (used / 10000).toFixed(0) + '만';
      const remainStr = remaining > 0 ? `${(remaining / 10000).toFixed(0)}만 가능` : '마감';
      const emoji = remaining <= 0 ? '🔴' : remaining < 100000 ? '🟡' : '🟢';

      // 수요일 블락 슬롯 표시
      const isBlocked = targetDate.getDay() === 3 && WED_BLOCKED_HOURS.includes(h);
      if (isBlocked) {
        statusText += `⛔ *${String(h).padStart(2,'0')}시* ${bar} 발송 불가 (수요일)
`;
      } else {
        statusText += `${emoji} *${String(h).padStart(2,'0')}시* ${bar} ${usedStr} / 40만 (${remainStr})
`;
      }
    }

    await client.chat.postMessage({
      channel: command.user_id,
      text: `📊 ${dateStr} 슬롯 현황`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: statusText } }],
    });
  } catch (error) {
    logger.error(error);
    await client.chat.postMessage({
      channel: command.user_id,
      text: '❌ 현황 조회 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
    });
  }
});

// ── 일정 변경 헤더 블록 빌더 ────────────────────────────────────
function buildChangeHeaderBlocks(data) {
  const mappingSummary = (data.mappingsJson || [])
    .map(m => `• ${m.oldSlot.label} → ${m.newSlot.label} | ${m.newSlot.count.toLocaleString()}건`)
    .join('\n');
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '*🔄 번개톡 일정 변경 검토 요청*\n',
          `*요청자:* <@${data.userId}>`,
          `*기존 날짜:* ${data.originalDateStr}`,
          `*변경 날짜:* ${data.sendDateStr}`,
          `*슬롯 매핑:*\n${mappingSummary}`,
          `*제목:* ${data.title}`,
          `*본문:* ${data.bodyText.substring(0, 100)}${data.bodyText.length > 100 ? '...' : ''}`,
          `*마수신 동의:* ${data.marketingConsent}`,
        ].join('\n'),
      },
    },
    { type: 'divider' },
  ];
}

// ── 일정 변경 헤더 블록 빌더 ────────────────────────────────────
function buildChangeHeaderBlocks(data) {
  const mappingSummary = (data.mappingsJson || [])
    .map(m => `• ${m.oldSlot.label} → ${m.newSlot.label} | ${m.newSlot.count.toLocaleString()}건`)
    .join('\n');
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '*🔄 번개톡 일정 변경 검토 요청*\n',
          `*요청자:* <@${data.userId}>`,
          `*기존 날짜:* ${data.originalDateStr}`,
          `*변경 날짜:* ${data.sendDateStr}`,
          `*슬롯 매핑:*\n${mappingSummary}`,
          `*제목:* ${data.title}`,
          `*본문:* ${data.bodyText.substring(0, 100)}${data.bodyText.length > 100 ? '...' : ''}`,
          `*마수신 동의:* ${data.marketingConsent}`,
        ].join('\n'),
      },
    },
    { type: 'divider' },
  ];
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
