import mongoose from "mongoose";
import { config } from "./config";

export async function connectDatabase(retries = 5) {
    while (retries > 0) {
        try {
            await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
            console.log("Connected to MongoDB via Mongoose");
            return;
        } catch (error: any) {
            console.error(`MongoDB connection failed (Retries left: ${retries - 1}):`, error.message);
            retries -= 1;
            if (retries === 0) {
                console.error("CRITICAL: Exhausted all MongoDB connection retries. Please check your IP whitelist and credentials.");
                // We won't exit the process so the bot can at least keep trying to reconnect later or stay alive,
                // but we resolve to let index.ts continue.
                return;
            }
            // Wait 5 seconds before retrying
            await new Promise(res => setTimeout(res, 5000));
        }
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
        lastVideoId: String,
        lastVideoPublishedAt: Date,
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
    addedBy: String,
    createdAt: { type: Date, default: Date.now },
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
    addedBy: String,
    lastReleaseId: String,
    lastReleasePublishedAt: Date,
});

export const ReleaseFeed = mongoose.model("ReleaseFeed", releaseFeedSchema);
