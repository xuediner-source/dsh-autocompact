/** Message patterns emitted by upstreams when the prompt exceeds the window. */
const OVERFLOW_RES: RegExp[] = [
  /prompt is too long/i,
  /context_length_exceeded/i,
  /maximum context/i,
  /context window.{0,40}(exceed|limit|full|over|too long|too large)/i,
  /(exceed|limit|full|over|too long|too large).{0,40}context window/i,
  /exceeds the model context/i,
  /model context limit/i,
  /超出模型长度上限/,
  /request_body_too_large/i,
  /request.{0,24}too.{0,12}large/i,
  // Gemini / Cloud Code Assist business code for context overflow.
  /\b11115\b/,
];

/** Extract the upstream's stated token limit, when the message carries one. */
const WINDOW_CAPTURE_RES: RegExp[] = [
  /tokens?\s*>\s*([\d,]+)\s*maximum/i,
  /maximum context length is\s*([\d,]+)/i,
  /context[_\s-]?length\D{0,24}([\d,]{4,})/i,
];

export function overflowLikely(message: string): boolean {
  return OVERFLOW_RES.some((re) => re.test(message));
}

export function captureWindow(message: string): number | undefined {
  for (const re of WINDOW_CAPTURE_RES) {
    const m = re.exec(message);
    if (m === null) continue;
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n >= 1000 && n <= 10_000_000) return Math.floor(n);
  }
  return undefined;
}
