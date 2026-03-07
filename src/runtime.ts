import type { Client } from "discord.js";
import { config } from "./config";

export type ServiceStatus = "starting" | "online" | "degraded" | "offline";
export type JobName = "youtube" | "releases";

interface RuntimeSection {
    status: ServiceStatus;
    lastUpdatedAt: string;
    lastError: string | null;
}

interface JobState extends RuntimeSection {
    isRunning: boolean;
    lastRunAt: string | null;
    lastSuccessAt: string | null;
}

const startedAt = new Date().toISOString();
const dashboardBinding = {
    host: config.host,
    port: config.port,
};

const runtimeState = {
    bot: {
        status: "starting" as ServiceStatus,
        lastUpdatedAt: startedAt,
        lastError: null as string | null,
        lastReadyAt: null as string | null,
    },
    database: {
        status: "starting" as ServiceStatus,
        lastUpdatedAt: startedAt,
        lastError: null as string | null,
        retryCount: 0,
        lastConnectedAt: null as string | null,
        lastDisconnectedAt: null as string | null,
    },
    commands: {
        status: "starting" as ServiceStatus,
        lastUpdatedAt: startedAt,
        lastError: null as string | null,
        lastSyncedAt: null as string | null,
        scope: config.guildId ? "guild" : "global",
        targetGuildId: config.guildId || null,
    },
    jobs: {
        youtube: createJobState(),
        releases: createJobState(),
    },
};

function createJobState(): JobState {
    return {
        status: "starting",
        lastUpdatedAt: startedAt,
        lastError: null,
        isRunning: false,
        lastRunAt: null,
        lastSuccessAt: null,
    };
}

function now() {
    return new Date().toISOString();
}

function updateSection<T extends RuntimeSection>(section: T, patch: Partial<T>) {
    Object.assign(section, patch, { lastUpdatedAt: now() });
}

export function setBotStatus(status: ServiceStatus, lastError?: string | null) {
    updateSection(runtimeState.bot, {
        status,
        lastError: lastError === undefined ? runtimeState.bot.lastError : lastError,
    });
    if (status === "online") {
        runtimeState.bot.lastReadyAt = now();
    }
}

export function setDatabaseStatus(
    status: ServiceStatus,
    patch: Partial<typeof runtimeState.database> = {}
) {
    updateSection(runtimeState.database, { status, ...patch });
}

export function setCommandsStatus(
    status: ServiceStatus,
    patch: Partial<typeof runtimeState.commands> = {}
) {
    updateSection(runtimeState.commands, { status, ...patch });
}

export function markJobStarted(jobName: JobName) {
    updateSection(runtimeState.jobs[jobName], {
        status: "starting",
        isRunning: true,
        lastRunAt: now(),
        lastError: null,
    });
}

export function markJobFinished(jobName: JobName, hadErrors = false, lastError: string | null = null) {
    updateSection(runtimeState.jobs[jobName], {
        status: hadErrors ? "degraded" : "online",
        isRunning: false,
        lastError,
    });
    if (!hadErrors) {
        runtimeState.jobs[jobName].lastSuccessAt = now();
    }
}

export function markJobOffline(jobName: JobName, error: string) {
    updateSection(runtimeState.jobs[jobName], {
        status: "offline",
        isRunning: false,
        lastError: error,
    });
}

export function setDashboardBinding(host: string, port: number) {
    dashboardBinding.host = host;
    dashboardBinding.port = port;
}

export function getRuntimeSnapshot(client?: Client) {
    return {
        startedAt,
        environment: {
            port: dashboardBinding.port,
            host: dashboardBinding.host,
            guildId: config.guildId || null,
            dnsServers: config.dnsServers.length ? config.dnsServers : null,
            replit: Boolean(process.env.REPL_ID),
            deployment: Boolean(process.env.REPLIT_DEPLOYMENT),
            dashboardProtected: Boolean(config.dashboardToken),
        },
        bot: {
            ...runtimeState.bot,
            isReady: client?.isReady() ?? false,
            tag: client?.user?.tag ?? null,
            guildCount: client?.guilds.cache.size ?? 0,
            ping: client?.ws.ping ?? null,
        },
        database: { ...runtimeState.database },
        commands: { ...runtimeState.commands },
        jobs: {
            youtube: { ...runtimeState.jobs.youtube },
            releases: { ...runtimeState.jobs.releases },
        },
    };
}
