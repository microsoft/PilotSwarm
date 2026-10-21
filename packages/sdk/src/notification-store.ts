import type { Pool } from "pg";
import type { ExecutablePackageIdentity } from "./agent-package-authorization.js";

export type UserNotificationKind = "package_review" | "cron_precheck_broken" | "cron_precheck_recovered";

export interface UserNotification {
    id: string;
    kind: UserNotificationKind;
    payload: Record<string, unknown>;
    occurrences: number;
    createdAt: Date;
    notifiedAt: Date;
    lastSeenAt: Date;
    readAt: Date | null;
    resolvedAt: Date | null;
}

export interface NotificationPrincipal {
    provider: string;
    subject: string;
}

export interface CronPrecheckBrokenNotice {
    sessionId: string;
    precheck: string;
    outcome: string;
    packageId?: string;
    packageIdentity?: ExecutablePackageIdentity;
}

/**
 * Per-user notifications (migration 0090). Writers are trusted worker paths;
 * readers act only on the server-resolved principal, never a body value.
 */
export interface NotificationCatalog {
    notifyCronPrecheckBroken(notice: CronPrecheckBrokenNotice): Promise<number>;
    resolveCronPrecheckBroken(sessionId: string): Promise<number>;
    list(principal: NotificationPrincipal | null, options?: { unreadOnly?: boolean; limit?: number }): Promise<UserNotification[]>;
    markRead(principal: NotificationPrincipal | null, ids?: string[] | null): Promise<number>;
}

export class NotificationError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}

function requirePrincipal(principal: NotificationPrincipal | null | undefined): NotificationPrincipal {
    if (!principal?.provider?.trim() || !principal?.subject?.trim()) {
        throw new NotificationError("FORBIDDEN", "Authenticated principal required");
    }
    return principal;
}

export class PgNotificationStore implements NotificationCatalog {
    private readonly schema: string;
    constructor(private readonly pool: Pool, schema: string) {
        this.schema = `"${schema.replace(/"/g, '""')}"`;
    }

    async notifyCronPrecheckBroken(notice: CronPrecheckBrokenNotice): Promise<number> {
        const identity = notice.packageIdentity;
        const { rows } = await this.pool.query(
            `SELECT ${this.schema}.cms_notify_cron_precheck_broken($1,$2,$3,$4,$5,$6) AS count`,
            [notice.sessionId, notice.precheck, notice.outcome,
                identity?.packageId ?? notice.packageId ?? null, identity?.versionId ?? null, identity?.sha256 ?? null],
        );
        return Number(rows[0]?.count ?? 0);
    }

    async resolveCronPrecheckBroken(sessionId: string): Promise<number> {
        const { rows } = await this.pool.query(
            `SELECT ${this.schema}.cms_resolve_cron_precheck_broken($1) AS count`, [sessionId]);
        return Number(rows[0]?.count ?? 0);
    }

    async list(principal: NotificationPrincipal | null, options: { unreadOnly?: boolean; limit?: number } = {}): Promise<UserNotification[]> {
        const actor = requirePrincipal(principal);
        const limit = Number.isSafeInteger(options.limit) ? options.limit : null;
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.schema}.cms_list_user_notifications($1,$2,$3,$4)`,
            [actor.provider, actor.subject, options.unreadOnly === true, limit],
        );
        return rows.map((row: any) => ({
            id: String(row.notification_id),
            kind: row.kind,
            payload: row.payload ?? {},
            occurrences: Number(row.occurrences),
            createdAt: new Date(row.created_at),
            notifiedAt: new Date(row.notified_at),
            lastSeenAt: new Date(row.last_seen_at),
            readAt: row.read_at ? new Date(row.read_at) : null,
            resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
        }));
    }

    async markRead(principal: NotificationPrincipal | null, ids?: string[] | null): Promise<number> {
        const actor = requirePrincipal(principal);
        let values: string[] | null = null;
        if (ids != null) {
            if (!Array.isArray(ids) || ids.length > 500 || !ids.every((id) => typeof id === "string" && /^[1-9][0-9]{0,18}$/.test(id))) {
                throw new NotificationError("INVALID_REQUEST", "ids must be up to 500 notification IDs");
            }
            values = ids;
        }
        const { rows } = await this.pool.query(
            `SELECT ${this.schema}.cms_mark_user_notifications_read($1,$2,$3::BIGINT[]) AS count`,
            [actor.provider, actor.subject, values],
        );
        return Number(rows[0]?.count ?? 0);
    }
}
