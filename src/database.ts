import mongoose from "mongoose";
import { config } from "./config";

export async function connectDatabase() {
    try {
        await mongoose.connect(config.mongoUri);
        console.log("Connected to MongoDB");
    } catch (error) {
        console.error("Failed to connect to MongoDB:", error);
        process.exit(1);
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
