// Honeypot channel: any post in it is a finding, whatever it says. The pipeline checks it before any scan.

/** { rule, reason } when the honeypot rule is on and the message was posted in its channel, else null.
 *  A channel that was deleted just never matches again, so a stale setting is harmless. */
export function honeypotFinding(message, autoConfig) {
  const rule = autoConfig?.rules?.honeypot;
  if (!rule?.enabled || !rule.channelId) return null;
  return message?.channelId === rule.channelId ? { rule: 'honeypot', reason: 'honeypot' } : null;
}
