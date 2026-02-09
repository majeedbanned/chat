/**
 * Notify formmaker3 to send push notifications for chat events.
 * Formmaker3 resolves push tokens and sends via ASMX push service.
 *
 * Base URL is derived from domain: in dev (domain contains localhost) use http,
 * otherwise https://<domain>. Optional env override:
 *   FORMMAKER3_BASE_URL - override base URL for all requests (no trailing slash)
 *   FORMMAKER3_DEV_URL  - override in dev only, e.g. http://localhost:3000
 *   CHAT_NOTIFY_SECRET  - optional; if set, sent as Bearer token
 */

const CHAT_NOTIFY_SECRET = process.env.CHAT_NOTIFY_SECRET || '';

/**
 * Get formmaker3 base URL from domain. Dev (localhost) → http, else → https.
 * @param {string} domain - e.g. parsplus.farsamooz.ir or localhost:3000
 * @returns {string} Base URL with no trailing slash, or empty if no domain
 */
function getBaseUrl(domain) {
  if (process.env.FORMMAKER3_BASE_URL) {
    return process.env.FORMMAKER3_BASE_URL.replace(/\/$/, '');
  }
  if (!domain) return '';
  const isLocalhost = domain.includes('localhost');
  if (isLocalhost) {
    return (process.env.FORMMAKER3_DEV_URL || `http://${domain}`).replace(/\/$/, '');
  }
  const protocol = domain.startsWith('http') ? '' : 'https://';

  //majKAJ
//  return 'http://192.168.70.156:3000';
  return (protocol + domain).replace(/\/$/, '');
}

function getHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (CHAT_NOTIFY_SECRET) {
    headers['Authorization'] = `Bearer ${CHAT_NOTIFY_SECRET}`;
  }
  return headers;
}

/**
 * Call formmaker3 notify-new-message endpoint.
 * @param {Object} params
 * @param {string} params.domain
 * @param {string} params.schoolCode
 * @param {string} params.chatroomId
 * @param {string} params.chatroomName
 * @param {string} params.senderName
 * @param {string} params.messagePreview
 * @param {string[]} [params.recipientStudentCodes]
 * @param {string[]} [params.recipientTeacherCodes]
 * @param {string[]} [params.recipientClassCodes] - all students in these classes get push
 * @param {string} [params.senderCode] - excluded from recipients
 */
async function notifyNewMessage(params) {
  const baseUrl = getBaseUrl(params.domain);
  if (!baseUrl) {
   // console.log('[notifyFormmaker3] No domain / base URL, skipping new-message push');
    return;
  }
  const studentCount = (params.recipientStudentCodes || []).length;
  const teacherCount = (params.recipientTeacherCodes || []).length;
  const classCount = (params.recipientClassCodes || []).length;
  // console.log(
  //   '[notifyFormmaker3] Sending new-message notification:',
  //   'baseUrl=', baseUrl,
  //   'room=', params.chatroomName,
  //   'sender=', params.senderName,
  //   'recipients=', studentCount, 'students,', teacherCount, 'teachers,', classCount, 'classes',
  // );
  const url = `${baseUrl}/api/mobileapp/chat/notify-new-message`;
  const body = {
    domain: params.domain,
    schoolCode: params.schoolCode,
    chatroomId: params.chatroomId,
    chatroomName: params.chatroomName,
    senderName: params.senderName,
    messagePreview: params.messagePreview,
    recipientStudentCodes: params.recipientStudentCodes || [],
    recipientTeacherCodes: params.recipientTeacherCodes || [],
    recipientClassCodes: params.recipientClassCodes || [],
    senderCode: params.senderCode,
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[notifyFormmaker3] new-message push failed:', res.status, JSON.stringify(data));
      return;
    }
    if (data.sent) {
     // console.log('[notifyFormmaker3] new-message notification sent successfully to', data.tokenCount, 'device(s)');
    } else {
    //  console.log('[notifyFormmaker3] new-message notification not sent:', data.error || data.reason || 'no tokens');
    }
  } catch (err) {
    console.error('[notifyFormmaker3] new-message push error:', err.message);
  }
}

/**
 * Call formmaker3 notify-mention endpoint.
 * Pass same codes in both arrays; formmaker3 resolves student vs teacher by lookup.
 *
 * @param {Object} params
 * @param {string} params.domain
 * @param {string} params.schoolCode
 * @param {string} params.chatroomId
 * @param {string} params.chatroomName
 * @param {string} params.senderName
 * @param {string} params.messagePreview
 * @param {string[]} [params.mentionedStudentCodes]
 * @param {string[]} [params.mentionedTeacherCodes]
 */
async function notifyMention(params) {
  const baseUrl = getBaseUrl(params.domain);
  if (!baseUrl) {
    console.log('[notifyFormmaker3] No domain / base URL, skipping mention push');
    return;
  }
  const mentionedCount = (params.mentionedStudentCodes || []).length + (params.mentionedTeacherCodes || []).length;
  // console.log(
  //   '[notifyFormmaker3] Sending mention notification:',
  //   'baseUrl=', baseUrl,
  //   'room=', params.chatroomName,
  //   'sender=', params.senderName,
  //   'mentioned=', mentionedCount
  // );
  const url = `${baseUrl}/api/mobileapp/chat/notify-mention`;
  const body = {
    domain: params.domain,
    schoolCode: params.schoolCode,
    chatroomId: params.chatroomId,
    chatroomName: params.chatroomName,
    senderName: params.senderName,
    messagePreview: params.messagePreview,
    mentionedStudentCodes: params.mentionedStudentCodes || [],
    mentionedTeacherCodes: params.mentionedTeacherCodes || [],
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[notifyFormmaker3] mention push failed:', res.status, JSON.stringify(data));
      return;
    }
    if (data.sent) {
    //  console.log('[notifyFormmaker3] mention notification sent successfully to', data.tokenCount, 'device(s)');
    } else {
    //  console.log('[notifyFormmaker3] mention notification not sent:', data.error || data.reason || 'no tokens');
    }
  } catch (err) {
    console.error('[notifyFormmaker3] mention push error:', err.message);
  }
}

module.exports = {
  notifyNewMessage,
  notifyMention,
};
