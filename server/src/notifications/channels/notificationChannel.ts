/**
 * Milestone 5 (docs/milestones/milestone-5-notification-system.md,
 * "External channels"): a thin adapter interface so the daemon can reach the
 * user outside the app without the caller knowing which channel it's talking to.
 *
 * Intentionally kept with no current caller: the LLM Notification Agent that
 * used it was removed, and this stays as plumbing for a future rule-based
 * escalation.
 *
 * One implementation per channel lives alongside this file (see
 * whatsappChannel.ts); a future Telegram adapter (listed as a fast-follow,
 * not part of this milestone) would implement this same interface without
 * any caller changing.
 *
 * Kept to the one method actually called anywhere — no `receive`/`validate`/
 * etc. until something needs them (YAGNI). Two-way/inbound replies
 * (docs/milestones/milestone-5-notification-system.md, "Two-way: the user
 * talking back") are a per-channel HTTP route into the daemon, not a method
 * on this interface.
 */
export interface NotificationChannel {
  send(message: string, target: string): Promise<void>;
}
