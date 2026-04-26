/**
 * Slack sink — post selected spans as messages to a Slack incoming webhook.
 *
 * Built for ops-style routing: errors, expensive LLM calls, slow tools.
 * Pair with a `match` rule that filters to high-signal events; sending
 * every span to Slack would flood the channel.
 *
 * Usage:
 *   import { slack } from '@daslab/agent-otel/sinks/slack';
 *
 *   const router = defineRouter({
 *     sinks: {
 *       alerts: slack({ webhookUrl: process.env.SLACK_WEBHOOK_URL! }),
 *     },
 *     rules: [
 *       // Bark when an LLM call costs >$1
 *       { match: { 'llm.cost.total': '>1.0' }, to: ['alerts'] },
 *       // Bark on every error
 *       { match: { status_code: 'ERROR' },     to: ['alerts'] },
 *     ],
 *   });
 */

import type { RoutedSpan, Sink } from '../types.js';

export interface SlackSinkOptions {
  /** Slack incoming webhook URL. */
  webhookUrl: string;
  /**
   * Optional formatter. Receives a RoutedSpan, returns the Slack message
   * payload. Default: a clean summary of name, kind, status, key attrs,
   * duration. Override for richer messages or block-kit formatting.
   */
  format?: (span: RoutedSpan) => SlackMessage;
  /** Override sink name (default: 'slack'). */
  name?: string;
  /**
   * Throttle: max messages per minute. Excess are dropped (with a warning
   * to console). Slack ratelimits aggressive webhooks.
   * Default: 30/min.
   */
  rateLimitPerMinute?: number;
}

/** Subset of the Slack incoming webhook payload format. */
export interface SlackMessage {
  text?: string;
  blocks?: unknown[];
  attachments?: unknown[];
}

function defaultFormat(span: RoutedSpan): SlackMessage {
  const a = span.attributes;
  const lines: string[] = [];

  const statusEmoji =
    span.status.code === 'ERROR' ? '❌' :
    span.status.code === 'OK'    ? '✅' : '•';

  lines.push(`${statusEmoji} *${span.name}* (${span.kind})  _${span.durationMs.toFixed(0)}ms_`);

  if (span.status.message) {
    lines.push(`> ${span.status.message}`);
  }

  // Surface high-signal attributes if present
  const keys = [
    'gen_ai.system', 'gen_ai.request.model',
    'llm.token_count.prompt', 'llm.token_count.completion', 'llm.cost.total',
    'db.system', 'db.statement',
    'http.request.method', 'http.response.status_code', 'url.full',
    'code.command', 'code.exit_code',
    'exception.message',
  ];
  const surfaced: string[] = [];
  for (const k of keys) {
    const v = a[k];
    if (v === undefined) continue;
    const val = typeof v === 'string' ? v.slice(0, 200) : String(v);
    surfaced.push(`\`${k}\`: ${val}`);
  }
  if (surfaced.length) lines.push(surfaced.join('  ·  '));

  lines.push(`_trace_: \`${span.traceId.slice(0, 16)}\`  _span_: \`${span.spanId.slice(0, 16)}\``);

  return { text: lines.join('\n') };
}

export function slack(opts: SlackSinkOptions): Sink {
  const format = opts.format ?? defaultFormat;
  const rateLimit = opts.rateLimitPerMinute ?? 30;

  // Sliding-window rate limiter: timestamps of recent posts in the last minute
  const recent: number[] = [];
  let dropped = 0;
  let lastDropWarn = 0;

  return {
    name: opts.name ?? 'slack',
    async consume(span) {
      const now = Date.now();
      // Drop entries older than 60s
      while (recent.length && recent[0]! < now - 60_000) recent.shift();
      if (recent.length >= rateLimit) {
        dropped++;
        // Warn at most once every 60s so logs don't get spammed too
        if (now - lastDropWarn > 60_000) {
          console.warn(`[agent-otel] slack sink rate-limited: dropped ${dropped} message(s) in last minute`);
          lastDropWarn = now;
          dropped = 0;
        }
        return;
      }
      recent.push(now);

      const body = format(span);
      const res = await fetch(opts.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '<no body>');
        throw new Error(`Slack webhook ${res.status}: ${txt.slice(0, 200)}`);
      }
    },
  };
}
