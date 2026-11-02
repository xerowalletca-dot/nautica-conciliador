// Cliente mínimo de la Bot API de Telegram (sin dependencias).

export class TelegramClient {
  constructor(token, { fetchImpl = fetch } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
  }

  async api(method, body, { timeoutMs = 30000 } = {}) {
    if (!this.token) throw new Error('Falta el token del bot de Telegram en Ajustes.');
    const isForm = body instanceof FormData;
    const res = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: isForm ? undefined : { 'Content-Type': 'application/json' },
      body: isForm ? body : JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || `HTTP ${res.status}`}`);
    return data.result;
  }

  getMe() {
    return this.api('getMe');
  }

  sendMessage(chatId, text, extra = {}) {
    return this.api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  }

  sendDocument(chatId, buffer, filename, caption = '', extra = {}) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }
    for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    form.append('document', new Blob([buffer]), filename);
    return this.api('sendDocument', form, { timeoutMs: 60000 });
  }

  getUpdates(offset, timeout = 25) {
    return this.api('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: (timeout + 10) * 1000 });
  }

  answerCallback(id, text) {
    return this.api('answerCallbackQuery', { callback_query_id: id, text });
  }

  async downloadFile(fileId) {
    const file = await this.api('getFile', { file_id: fileId });
    const res = await this.fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`No se pudo descargar el archivo de Telegram (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
