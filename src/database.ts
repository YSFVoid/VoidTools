import mongoose from "mongoose";
import { config } from "./config";
import { setDatabaseStatus } from "./runtime";

let activeConnectionAttempt: Promise<boolean> | null = null;

mongoose.set("bufferCommands", false);

function getMongoUriConfigIssue(uri: string) {
    const trimmed = uri.trim();
    if (!trimmed) {
        return "MONGODB_URI is empty.";
    }

    const atlasSingleHostUri =
        trimmed.startsWith("mongodb://") &&
        trimmed.includes(".mongodb.net") &&
        !trimmed.includes(",") &&
        !/\.[a-z]+:\d+/i.test(trimmed);

    if (atlasSingleHostUri) {
        return "MONGODB_URI points to MongoDB Atlas with `mongodb://` and a single host. Use the Atlas `mongodb+srv://` URI or a full seed list with ports.";
    }

    return null;
}

function getMongoFailureHint(message: string) {
    const normalized = message.toLowerCase();

    if (normalized.includes("enotfound")) {
        return "DNS or hostname lookup failed. Check the cluster hostname in MONGODB_URI.";
    }

    if (normalized.includes("authentication failed")) {
        return "MongoDB rejected the username or password in MONGODB_URI.";
    }

    if (normalized.includes("whitelist") || normalized.includes("not allowed to access")) {
        return "Atlas network access is blocking this machine's IP address.";
    }

    return null;
}

mongoose.connection.on("connected", () => {
    setDatabaseStatus("online", {
        lastConnectedAt: new Date().toISOString(),
        lastError: null,
    });
});

mongoose.connection.on("disconnected", () => {
    setDatabaseStatus("offline", {
        lastDisconnectedAt: new Date().toISOString(),
    });
});

mongoose.connection.on("error", (error) => {
    setDatabaseStatus("degraded", { lastError: error.message });
});

export function isDatabaseReady() {
    return mongoose.connection.readyState === 1;
}

export async function connectDatabase(retries = 5, delayMs = 5000): Promise<boolean> {
    if (isDatabaseReady()) return true;
    if (activeConnectionAttempt) return activeConnectionAttempt;

    const configIssue = getMongoUriConfigIssue(config.mongoUri);
    if (configIssue) {
        console.error(`MongoDB configuration error: ${configIssue}`);
        setDatabaseStatus("offline", { lastError: configIssue });
        return false;
    }

    activeConnectionAttempt = (async () => {
        let retriesLeft = retries;

        while (retriesLeft > 0) {
            try {
                setDatabaseStatus("starting", {
                    retryCount: retries - retriesLeft,
                    lastError: null,
                });

                await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
                console.log("Connected to MongoDB via Mongoose");
                return true;
            } catch (error: any) {
                retriesLeft -= 1;
                const message = error instanceof Error ? error.message : String(error);
                const hint = getMongoFailureHint(message);
                console.error(
                    `MongoDB connection failed (Retries left: ${retriesLeft}):`,
                    hint ? `${message} Hint: ${hint}` : message
                );
                setDatabaseStatus(retriesLeft > 0 ? "degraded" : "offline", {
                    retryCount: retries - retriesLeft,
                    lastError: hint ? `${message} Hint: ${hint}` : message,
                });

                if (retriesLeft === 0) {
                    console.error("CRITICAL: Exhausted all MongoDB connection retries. Please check your IP whitelist and credentials.");
                    return false;
                }

                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }

        return false;
    })();

    try {
        return await activeConnectionAttempt;
    } finally {
        activeConnectionAttempt = null;
    }
}

// Models
const guildConfigSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    prefix: { type: String, default: "!" },
    roleIds: {
        adminRoleId: String,
        modRoleId: String,
        supportRoleId: String,
        vipRoleId: String,
        verifiedRoleId: String,
        youtubeNotifsRoleId: String,
        quarantineRoleId: String,
    },
    channelIds: {
        announcementsId: String,
        verifyId: String,
        toolsId: String,
        toolReleasesId: String,
        supportId: String,
        requestsId: String,
        reportsId: String,
        logsId: String,
        sellingRulesId: String,
        sellingToolsId: String,
        buyRequestsId: String,
    },
    categoryIds: {
        infoId: String,
        toolsId: String,
        supportId: String,
        securityId: String,
        sellingId: String,
        staffId: String,
        logsId: String,
    },
    setupWizard: {
        githubValue: String,
        youtubeChannelId: String,
        sellingDescription: String,
        sellingContact: String,
        notifyChannelId: String,
    },
    youtube: {
        channelInput: String,
        notifyChannelId: String,
        lastVideoId: String,
        lastVideoPublishedAt: Date,
    },
    panelRefs: {
        setupWizard: {
            channelId: String,
            messageId: String,
        },
        verify: {
            channelId: String,
            messageId: String,
        },
        ticket: {
            channelId: String,
            messageId: String,
        },
    },
    security: {
        whitelistedDomains: [String],
        quarantinedUsers: [String],
    }
});

export const GuildConfig = mongoose.model("GuildConfig", guildConfigSchema);

const ticketSchema = new mongoose.Schema({
    guildId: { type: String, required: true },
    ticketId: { type: String, required: true, unique: true },
    channelId: { type: String, required: true },
    openerId: { type: String, required: true },
    type: { type: String, enum: ["support", "report", "partnership", "buying"], required: true },
    status: { type: String, enum: ["open", "closed"], default: "open" },
    createdAt: { type: Date, default: Date.now },
    closedAt: Date,
    closedBy: String,
    closeReason: String,
    transcriptUrl: String,
});

export const Ticket = mongoose.model("Ticket", ticketSchema);

const toolSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    category: String,
    description: String,
    version: String,
    url: String,
    sourceUrl: String,
    downloadUrl: String,
    imageUrl: String,
    thumbnailUrl: String,
    addedBy: String,
    createdAt: { type: Date, default: Date.now },
    publishedChannelId: String,
    publishedMessageId: String,
    lastPostedAt: Date,
    filename: String,
    sha256: String,
    size: String,
});

export const Tool = mongoose.model("Tool", toolSchema);

const warningSchema = new mongoose.Schema({
    guildId: String,
    userId: String,
    reason: String,
    moderatorId: String,
    createdAt: { type: Date, default: Date.now },
});

export const Warning = mongoose.model("Warning", warningSchema);

const releaseFeedSchema = new mongoose.Schema({
    guildId: { type: String, required: true },
    url: { type: String, required: true },
    repoUrl: String,
    repoOwner: String,
    repoName: String,
    repoFullName: String,
    targetChannelId: String,
    watchReleases: { type: Boolean, default: true },
    watchCommits: { type: Boolean, default: false },
    defaultBranch: String,
    addedBy: String,
    lastReleaseId: String,
    lastReleasePublishedAt: Date,
    lastCommitSha: String,
    lastCommitPublishedAt: Date,
});

export const ReleaseFeed = mongoose.model("ReleaseFeed", releaseFeedSchema);
