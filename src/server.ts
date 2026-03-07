import type { Server } from "node:http";
import express, { Request } from "express";
import { Client } from "discord.js";
import { config } from "./config";
import { getRuntimeSnapshot, setDashboardBinding } from "./runtime";

type DashboardActionName = "retry-db" | "sync-commands" | "poll-youtube" | "poll-releases";
type DashboardAction = () => Promise<string | void>;

const app = express();
let dashboardStarted = false;
let dashboardClient: Client | null = null;
const dashboardActions = new Map<DashboardActionName, DashboardAction>();
const dashboardPortWasConfigured = Boolean(process.env.PORT?.trim());
const dashboardPortFallbackAttempts = 10;

app.disable("x-powered-by");
app.use(express.json());

function isAuthorized(request: Request) {
    if (!config.dashboardToken) {
        const candidateIps = [request.ip, request.socket.remoteAddress]
            .filter((value): value is string => Boolean(value))
            .map((value) => value.replace("::ffff:", ""));

        return candidateIps.some((value) => ["127.0.0.1", "::1", "localhost"].includes(value));
    }

    const authorization = request.header("authorization") || "";
    const bearerToken = authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : "";
    const headerToken = request.header("x-dashboard-token") || "";
    const queryToken = typeof request.query.token === "string" ? request.query.token : "";

    return [bearerToken, headerToken, queryToken].includes(config.dashboardToken);
}

function getSnapshot() {
    return getRuntimeSnapshot(dashboardClient ?? undefined);
}

function statusCodeForReadyCheck(snapshot = getSnapshot()) {
    return snapshot.bot.isReady ? 200 : 503;
}

function escapeJson(value: unknown) {
    return JSON.stringify(value).replace(/</g, "\\u003c");
}

function renderDashboard() {
    const snapshot = getSnapshot();
    const protectedMode = snapshot.environment.dashboardProtected ? "protected" : "open";
    const initialSnapshot = escapeJson(snapshot);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VoidTools Control</title>
    <style>
        :root {
            --bg: #07111f;
            --panel: rgba(13, 26, 45, 0.86);
            --panel-border: rgba(93, 140, 205, 0.24);
            --panel-strong: rgba(18, 40, 69, 0.98);
            --text: #eaf2ff;
            --muted: #9fb3cf;
            --good: #5ce0a0;
            --warn: #f3c35c;
            --bad: #ff7c7c;
            --accent: #7cb7ff;
            --accent-strong: #3f8cff;
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            min-height: 100vh;
            font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
            color: var(--text);
            background:
                radial-gradient(circle at top, rgba(76, 128, 212, 0.28), transparent 36%),
                radial-gradient(circle at right bottom, rgba(43, 118, 191, 0.18), transparent 28%),
                linear-gradient(180deg, #09111e 0%, #04070d 100%);
        }

        main {
            width: min(1100px, calc(100% - 32px));
            margin: 32px auto;
            display: grid;
            gap: 20px;
        }

        .hero,
        .panel {
            background: var(--panel);
            border: 1px solid var(--panel-border);
            border-radius: 20px;
            backdrop-filter: blur(16px);
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.28);
        }

        .hero {
            padding: 28px;
            display: grid;
            gap: 18px;
        }

        .hero-top {
            display: flex;
            flex-wrap: wrap;
            justify-content: space-between;
            gap: 12px;
            align-items: flex-start;
        }

        h1, h2, h3, p {
            margin: 0;
        }

        h1 {
            font-size: clamp(2rem, 5vw, 3rem);
            letter-spacing: 0.02em;
        }

        .subtitle {
            color: var(--muted);
            max-width: 60ch;
            line-height: 1.5;
        }

        .badge-row {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
        }

        .badge {
            border: 1px solid rgba(124, 183, 255, 0.25);
            background: rgba(63, 140, 255, 0.09);
            color: var(--text);
            border-radius: 999px;
            padding: 8px 12px;
            font-size: 0.92rem;
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
            gap: 16px;
        }

        .card {
            background: var(--panel-strong);
            border: 1px solid rgba(124, 183, 255, 0.14);
            border-radius: 16px;
            padding: 18px;
            display: grid;
            gap: 10px;
        }

        .card h3 {
            font-size: 0.95rem;
            color: var(--muted);
            text-transform: uppercase;
            letter-spacing: 0.08em;
        }

        .status-line {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 1.1rem;
        }

        .dot {
            width: 12px;
            height: 12px;
            border-radius: 999px;
            box-shadow: 0 0 16px currentColor;
        }

        .status-online { color: var(--good); }
        .status-starting { color: var(--warn); }
        .status-degraded { color: var(--warn); }
        .status-offline { color: var(--bad); }

        .meta {
            color: var(--muted);
            line-height: 1.5;
            font-size: 0.95rem;
        }

        .panel {
            padding: 22px;
            display: grid;
            gap: 18px;
        }

        .controls {
            display: grid;
            gap: 14px;
        }

        .controls-top {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            align-items: center;
            justify-content: space-between;
        }

        .token {
            display: flex;
            gap: 10px;
            align-items: center;
            flex-wrap: wrap;
        }

        input {
            min-width: 260px;
            max-width: 100%;
            padding: 12px 14px;
            border-radius: 12px;
            border: 1px solid rgba(124, 183, 255, 0.2);
            background: rgba(4, 11, 20, 0.75);
            color: var(--text);
        }

        button {
            border: 0;
            border-radius: 12px;
            padding: 12px 16px;
            font-weight: 600;
            cursor: pointer;
            color: #03101f;
            background: linear-gradient(135deg, #8dc1ff 0%, #59d7c4 100%);
            transition: transform 140ms ease, opacity 140ms ease;
        }

        button.secondary {
            color: var(--text);
            background: rgba(124, 183, 255, 0.12);
            border: 1px solid rgba(124, 183, 255, 0.25);
        }

        button:disabled {
            opacity: 0.55;
            cursor: default;
        }

        button:hover:enabled {
            transform: translateY(-1px);
        }

        .button-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 12px;
        }

        .action-log {
            min-height: 48px;
            padding: 14px;
            border-radius: 14px;
            background: rgba(2, 8, 15, 0.7);
            border: 1px solid rgba(124, 183, 255, 0.14);
            color: var(--muted);
            white-space: pre-wrap;
            line-height: 1.5;
        }

        .api-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
            gap: 12px;
            font-family: Consolas, "Courier New", monospace;
            font-size: 0.92rem;
        }

        .api-box {
            padding: 14px;
            border-radius: 14px;
            background: rgba(2, 8, 15, 0.7);
            border: 1px solid rgba(124, 183, 255, 0.14);
        }

        code {
            color: #c4e0ff;
        }

        @media (max-width: 720px) {
            main {
                width: min(100% - 20px, 1100px);
                margin: 18px auto 24px;
            }

            .hero,
            .panel {
                padding: 18px;
            }

            input {
                min-width: 0;
                width: 100%;
            }
        }
    </style>
</head>
<body>
    <main>
        <section class="hero">
            <div class="hero-top">
                <div>
                    <h1>VoidTools Control</h1>
                    <p class="subtitle">
                        Replit-safe dashboard for startup visibility, health checks, and manual bot actions.
                        This page stays up even while MongoDB or Discord is still connecting.
                    </p>
                </div>
                <div class="badge-row">
                    <span class="badge">Mode: ${protectedMode}</span>
                    <span class="badge">Host: ${snapshot.environment.host}:${snapshot.environment.port}</span>
                    <span class="badge">Commands: ${snapshot.commands.scope}${snapshot.commands.targetGuildId ? ` (${snapshot.commands.targetGuildId})` : ""}</span>
                </div>
            </div>

            <div class="grid" id="status-grid"></div>
        </section>

        <section class="panel controls">
            <div class="controls-top">
                <div>
                    <h2>Actions</h2>
                    <p class="meta">
                        Use these controls after fixing secrets or MongoDB network access.
                    </p>
                </div>
                <div class="token">
                    <input id="dashboard-token" type="password" placeholder="Dashboard token (if enabled)">
                    <button class="secondary" id="save-token">Save Token</button>
                </div>
            </div>

            <div class="button-grid">
                <button data-action="retry-db">Retry Database</button>
                <button data-action="sync-commands">Sync Commands</button>
                <button data-action="poll-youtube">Run YouTube Poll</button>
                <button data-action="poll-releases">Run GitHub Poll</button>
            </div>

            <div id="action-log" class="action-log">Waiting for action.</div>
        </section>

        <section class="panel">
            <div>
                <h2>Endpoints</h2>
                <p class="meta">These are useful for Replit health checks or quick diagnostics.</p>
            </div>
            <div class="api-grid">
                <div class="api-box"><code>GET /healthz</code><br>Process health. Returns 200 while the app is alive.</div>
                <div class="api-box"><code>GET /readyz</code><br>Bot readiness. Returns 200 only after Discord is ready.</div>
                <div class="api-box"><code>GET /api/status</code><br>Structured runtime snapshot for debugging.</div>
                <div class="api-box"><code>POST /api/actions/*</code><br>Protected manual controls for admin actions.</div>
            </div>
        </section>
    </main>

    <script>
        const statusGrid = document.getElementById("status-grid");
        const actionLog = document.getElementById("action-log");
        const tokenInput = document.getElementById("dashboard-token");
        const saveTokenButton = document.getElementById("save-token");
        const actionButtons = Array.from(document.querySelectorAll("[data-action]"));
        const STORAGE_KEY = "voidtools-dashboard-token";
        let snapshot = ${initialSnapshot};

        function statusClass(status) {
            return "status-" + status;
        }

        function formatValue(value, fallback = "N/A") {
            return value === null || value === undefined || value === "" ? fallback : value;
        }

        function relativeTime(value) {
            if (!value) return "N/A";
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return value;
            return date.toLocaleString();
        }

        function renderCards(current) {
            const cards = [
                {
                    title: "Bot",
                    status: current.bot.status,
                    lines: [
                        "User: " + formatValue(current.bot.tag),
                        "Ready: " + current.bot.isReady,
                        "Guilds: " + current.bot.guildCount,
                        "Ping: " + formatValue(current.bot.ping === null ? null : current.bot.ping + "ms"),
                        "Last ready: " + relativeTime(current.bot.lastReadyAt),
                    ],
                },
                {
                    title: "Database",
                    status: current.database.status,
                    lines: [
                        "Retries: " + current.database.retryCount,
                        "Last connected: " + relativeTime(current.database.lastConnectedAt),
                        "Last error: " + formatValue(current.database.lastError),
                    ],
                },
                {
                    title: "Commands",
                    status: current.commands.status,
                    lines: [
                        "Scope: " + current.commands.scope,
                        "Guild: " + formatValue(current.commands.targetGuildId),
                        "Last sync: " + relativeTime(current.commands.lastSyncedAt),
                        "Last error: " + formatValue(current.commands.lastError),
                    ],
                },
                {
                    title: "Jobs",
                    status: current.jobs.youtube.status === "offline" || current.jobs.releases.status === "offline"
                        ? "offline"
                        : current.jobs.youtube.status === "degraded" || current.jobs.releases.status === "degraded"
                            ? "degraded"
                            : current.jobs.youtube.isRunning || current.jobs.releases.isRunning
                                ? "starting"
                                : "online",
                    lines: [
                        "YouTube: " + current.jobs.youtube.status + " | Last run: " + relativeTime(current.jobs.youtube.lastRunAt),
                        "GitHub: " + current.jobs.releases.status + " | Last run: " + relativeTime(current.jobs.releases.lastRunAt),
                        "Last YouTube error: " + formatValue(current.jobs.youtube.lastError),
                        "Last GitHub error: " + formatValue(current.jobs.releases.lastError),
                    ],
                },
            ];

            statusGrid.innerHTML = cards.map((card) => {
                const lines = card.lines.map((line) => "<div>" + line + "</div>").join("");
                return [
                    '<article class="card">',
                    "<h3>" + card.title + "</h3>",
                    '<div class="status-line ' + statusClass(card.status) + '">',
                    '<span class="dot"></span>',
                    "<strong>" + card.status + "</strong>",
                    "</div>",
                    '<div class="meta">' + lines + "</div>",
                    "</article>",
                ].join("");
            }).join("");
        }

        function getSavedToken() {
            return localStorage.getItem(STORAGE_KEY) || "";
        }

        function log(message) {
            actionLog.textContent = "[" + new Date().toLocaleTimeString() + "] " + message;
        }

        async function refreshStatus() {
            try {
                const response = await fetch("/api/status", { cache: "no-store" });
                snapshot = await response.json();
                renderCards(snapshot);
            } catch (error) {
                log("Failed to refresh status: " + error.message);
            }
        }

        async function runAction(actionName) {
            const token = getSavedToken();
            const response = await fetch("/api/actions/" + actionName, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(token ? { Authorization: "Bearer " + token } : {}),
                },
            });

            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(body.error || "Request failed");
            }

            snapshot = body.status || snapshot;
            renderCards(snapshot);
            return body.message || "Action completed.";
        }

        tokenInput.value = getSavedToken();
        saveTokenButton.addEventListener("click", () => {
            localStorage.setItem(STORAGE_KEY, tokenInput.value.trim());
            log(tokenInput.value.trim() ? "Dashboard token saved in this browser." : "Dashboard token cleared.");
        });

        actionButtons.forEach((button) => {
            button.addEventListener("click", async () => {
                const action = button.getAttribute("data-action");
                if (!action) return;

                const originalText = button.textContent;
                button.disabled = true;
                button.textContent = "Working...";
                log("Running " + action + "...");

                try {
                    const message = await runAction(action);
                    log(message);
                } catch (error) {
                    log("Action failed: " + error.message);
                } finally {
                    button.disabled = false;
                    button.textContent = originalText;
                }
            });
        });

        renderCards(snapshot);
        setInterval(refreshStatus, 10000);
        void refreshStatus();
    </script>
</body>
</html>`;
}

function getDashboardPortCandidates() {
    if (dashboardPortWasConfigured) {
        return [config.port];
    }

    const candidates = new Set<number>([config.port]);
    for (let index = 1; index <= dashboardPortFallbackAttempts; index += 1) {
        candidates.add(config.port + index);
    }

    return [...candidates.values()];
}

function getDashboardUrl(host: string, port: number) {
    return `http://${host}:${port}`;
}

function logDashboardStartError(error: NodeJS.ErrnoException, port: number) {
    if (error.code === "EADDRINUSE") {
        console.warn(`Web dashboard port ${port} is already in use. Dashboard startup skipped.`);
        return;
    }

    console.error(`Web dashboard failed to start on ${config.host}:${port}: ${error.message}`);
}

function listenOnDashboardPort(port: number) {
    return new Promise<Server>((resolve, reject) => {
        const server = app.listen(port, config.host);

        const handleListening = () => {
            server.off("error", handleError);
            resolve(server);
        };

        const handleError = (error: NodeJS.ErrnoException) => {
            server.off("listening", handleListening);
            reject(error);
        };

        server.once("listening", handleListening);
        server.once("error", handleError);
    });
}

async function bindDashboardServer() {
    let lastError: NodeJS.ErrnoException | null = null;

    for (const port of getDashboardPortCandidates()) {
        try {
            const server = await listenOnDashboardPort(port);
            const usingFallbackPort = port !== config.port;
            setDashboardBinding(config.host, port);

            if (usingFallbackPort) {
                console.warn(
                    `Web dashboard port ${config.port} is already in use. Falling back to ${getDashboardUrl(config.host, port)}.`
                );
            }

            console.log(`Web dashboard listening on ${getDashboardUrl(config.host, port)}`);
            if (process.env.REPLIT_DEPLOYMENT && !config.dashboardToken) {
                console.warn("Dashboard token is not configured. Public dashboard actions will stay disabled on deployment.");
            }

            server.on("error", (error) => {
                logDashboardStartError(error as NodeJS.ErrnoException, port);
            });
            return;
        } catch (error) {
            const startError = error as NodeJS.ErrnoException;
            lastError = startError;

            if (startError.code === "EADDRINUSE" && !dashboardPortWasConfigured) {
                continue;
            }

            logDashboardStartError(startError, port);
            return;
        }
    }

    if (lastError) {
        if (lastError.code === "EADDRINUSE") {
            const attemptedPorts = getDashboardPortCandidates().join(", ");
            console.warn(`Web dashboard could not start because all candidate ports are in use: ${attemptedPorts}.`);
            return;
        }

        logDashboardStartError(lastError, config.port);
    }
}

app.get("/", (_request, response) => {
    response.type("html").send(renderDashboard());
});

app.get("/healthz", (_request, response) => {
    response.status(200).json({
        ok: true,
        status: "alive",
        snapshot: getSnapshot(),
    });
});

app.get("/readyz", (_request, response) => {
    const snapshot = getSnapshot();
    const statusCode = statusCodeForReadyCheck(snapshot);

    response.status(statusCode).json({
        ok: statusCode === 200,
        status: statusCode === 200 ? "ready" : snapshot.bot.status,
        snapshot,
    });
});

app.get("/api/status", (_request, response) => {
    response.json(getSnapshot());
});

app.post("/api/actions/:action", async (request, response) => {
    if (!isAuthorized(request)) {
        return response.status(401).json({ ok: false, error: "Unauthorized. Supply the dashboard token." });
    }

    const actionName = request.params.action as DashboardActionName;
    const action = dashboardActions.get(actionName);
    if (!action) {
        return response.status(404).json({ ok: false, error: "Unknown action." });
    }

    try {
        const result = await action();
        return response.json({
            ok: true,
            message: result || `${actionName} completed.`,
            status: getSnapshot(),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return response.status(500).json({
            ok: false,
            error: message,
            status: getSnapshot(),
        });
    }
});

export function startDashboard(
    client: Client,
    actions: Partial<Record<DashboardActionName, DashboardAction>> = {}
) {
    dashboardClient = client;

    for (const [actionName, handler] of Object.entries(actions)) {
        if (handler) {
            dashboardActions.set(actionName as DashboardActionName, handler);
        }
    }

    if (dashboardStarted) return;
    dashboardStarted = true;
    void bindDashboardServer();
}
