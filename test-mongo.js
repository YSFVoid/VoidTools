const { MongoClient } = require("mongodb");
const dns = require("node:dns");
require("dotenv").config();

const uri = process.env.MONGODB_URI;

function configureDnsServers() {
    const dnsServers = (process.env.DNS_SERVERS || "")
        .split(",")
        .map((server) => server.trim())
        .filter(Boolean);

    if (dnsServers.length === 0) {
        return;
    }

    try {
        dns.setServers(dnsServers);
    } catch (error) {
        console.error("Failed to apply DNS_SERVERS override:", error);
    }
}

function getMongoUriConfigIssue(value) {
    const trimmed = (value || "").trim();
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

function getMongoFailureHint(message) {
    const normalized = String(message || "").toLowerCase();

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

async function run() {
    configureDnsServers();

    if (!uri) {
        console.error("Missing MONGODB_URI in environment.");
        process.exitCode = 1;
        return;
    }

    const configIssue = getMongoUriConfigIssue(uri);
    if (configIssue) {
        console.error("MongoDB configuration error:", configIssue);
        process.exitCode = 1;
        return;
    }

    const client = new MongoClient(uri);

    try {
        console.log("Attempting direct connection...");
        await client.connect();
        console.log("Connected successfully.");
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        const hint = getMongoFailureHint(message);
        console.error("MongoDB connection failed:", hint ? `${message} Hint: ${hint}` : message);
        process.exitCode = 1;
    } finally {
        await client.close().catch(() => null);
    }
}

void run();
