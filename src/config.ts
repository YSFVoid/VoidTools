import dns from "node:dns";
import dotenv from "dotenv";
dotenv.config();

function readEnv(name: string) {
    return process.env[name]?.trim() || "";
}

function parsePort(value: string) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return 3000;
    }

    return parsed;
}

function configureDnsServers() {
    const dnsServers = readEnv("DNS_SERVERS")
        .split(",")
        .map((server) => server.trim())
        .filter(Boolean);

    if (dnsServers.length === 0) {
        return dnsServers;
    }

    try {
        dns.setServers(dnsServers);
    } catch (error) {
        console.error("Failed to apply DNS_SERVERS override:", error);
        return [];
    }

    return dnsServers;
}

const configuredDnsServers = configureDnsServers();

export const config = {
    token: readEnv("DISCORD_TOKEN"),
    guildId: readEnv("GUILD_ID"),
    mongoUri: readEnv("MONGODB_URI") || "mongodb://127.0.0.1:27017/voidtools",
    prefix: readEnv("BOT_PREFIX") || "!",
    port: parsePort(readEnv("PORT") || "3000"),
    host: readEnv("HOST") || "0.0.0.0",
    dashboardToken: readEnv("DASHBOARD_TOKEN"),
    githubToken: readEnv("GITHUB_TOKEN"),
    dnsServers: configuredDnsServers,
    colors: {
        primary: 0x7b2fbe,
        success: 0x2ecc71,
        warning: 0xf1c40f,
        error: 0xe74c3c,
        info: 0x9b59b6,
    },
    credits: "Developed by Ysf (Lone Wolf Developer)",
};

export const defaultChannels = {
    announcements: "𝐚𝐧𝐧𝐨𝐮𝐧𝐜𝐞𝐦𝐞𝐧𝐭𝐬",
    toolReleases: "𝐭𝐨𝐨𝐥-𝐫𝐞𝐥𝐞𝐚𝐬𝐞𝐬",
    tools: "𝐭𝐨𝐨𝐥𝐬",
    support: "𝐬𝐮𝐩𝐩𝐨𝐫𝐭",
    verify: "𝐯𝐞𝐫𝐢𝐟𝐲",
    requests: "𝐫𝐞𝐪𝐮𝐞𝐬𝐭𝐬",
    reports: "𝐫𝐞𝐩𝐨𝐫𝐭𝐬",
    logs: "𝐥𝐨𝐠𝐬",
    quarantine: "𝐪𝐮𝐚𝐫𝐚𝐧𝐭𝐢𝐧𝐞",
    sellingRules: "𝐬𝐞𝐥𝐥𝐢𝐧𝐠-𝐫𝐮𝐥𝐞𝐬",
    sellingTools: "𝐬𝐞𝐥𝐥𝐢𝐧𝐠-𝐭𝐨𝐨𝐥𝐬",
    buyRequests: "𝐛𝐮𝐲-𝐫𝐞𝐪𝐮𝐞𝐬𝐭𝐬"
};

export const defaultCategories = {
    info: "𝐈𝐍𝐅𝐎",
    tools: "𝐓𝐎𝐎𝐋𝐒",
    support: "𝐒𝐔𝐏𝐏𝐎𝐑𝐓",
    security: "𝐒𝐄𝐂𝐔𝐑𝐈𝐓𝐘",
    selling: "𝐒𝐄𝐋𝐋𝐈𝐍𝐆",
    staff: "𝐒𝐓𝐀𝐅𝐅",
    logs: "𝐋𝐎𝐆𝐒"
};

export const defaultRoles = {
    admin: "𝐕𝐨𝐢𝐝𝐓𝐨𝐨𝐥𝐬 𝐀𝐝𝐦𝐢𝐧",
    mod: "𝐕𝐨𝐢𝐝𝐓𝐨𝐨𝐥𝐬 𝐌𝐨𝐝",
    support: "𝐕𝐨𝐢𝐝𝐓𝐨𝐨𝐥𝐬 𝐒𝐮𝐩𝐩𝐨𝐫𝐭",
    vip: "𝐕𝐈𝐏",
    verified: "𝐕𝐞𝐫𝐢𝐟𝐢𝐞𝐝",
    quarantine: "𝐐𝐮𝐚𝐫𝐚𝐧𝐭𝐢𝐧𝐞",
    youtube: "𝐘𝐨𝐮𝐓𝐮𝐛𝐞 𝐍𝐨𝐭𝐢𝐟𝐬"
};
