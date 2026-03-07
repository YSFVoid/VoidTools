import mongoose from "mongoose";
import {
    ChannelType,
    Client,
    GatewayIntentBits,
    Guild,
    GuildMember,
    Message,
    PermissionFlagsBits,
    TextChannel,
} from "discord.js";
import { config } from "../src/config";
import { connectDatabase, getGuildConfig } from "../src/database";
import { executeSetup } from "../src/modules/setup";

type PanelKind = "setupWizard" | "verify" | "ticket";

interface StoredPanelRef {
    channelId: string;
    messageId: string;
}

interface PanelState {
    channelId: string | null;
    channelName: string | null;
    messageId: string | null;
    messageExists: boolean;
    messagePinned: boolean;
    matchingMessageCount: number;
    customIds: string[];
}

interface SetupRunResult {
    replies: string[];
}

const panelCustomIds: Record<PanelKind, string[]> = {
    setupWizard: ["setup_wizard_btn"],
    verify: ["verify_btn"],
    ticket: ["ticket_select", "ticket_btn_open"],
};

function getMessageCustomIds(message: Message) {
    return message.components.flatMap((row: any) =>
        Array.isArray(row.components)
            ? row.components
                  .map((component: any) => (typeof component.customId === "string" ? component.customId : null))
                  .filter((value: string | null): value is string => Boolean(value))
            : []
    );
}

function messageMatchesCustomIds(message: Message, customIds: string[]) {
    return getMessageCustomIds(message).some((customId) => customIds.includes(customId));
}

async function countMatchingPanelMessages(channel: TextChannel, customIds: string[]) {
    const uniqueMessages = new Map<string, Message>();

    const pinnedMessages = await channel.messages.fetchPinned().catch(() => null);
    for (const message of pinnedMessages?.values() || []) {
        uniqueMessages.set(message.id, message);
    }

    const recentMessages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    for (const message of recentMessages?.values() || []) {
        uniqueMessages.set(message.id, message);
    }

    return [...uniqueMessages.values()].filter((message) => messageMatchesCustomIds(message, customIds)).length;
}

async function getTextChannel(guild: Guild, channelId: string | null | undefined) {
    if (!channelId) {
        return null;
    }

    const channel =
        guild.channels.cache.get(channelId) ||
        (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel || channel.type !== ChannelType.GuildText) {
        return null;
    }

    return channel as TextChannel;
}

async function resolveInvoker(guild: Guild) {
    const owner = await guild.fetchOwner().catch(() => null);
    if (owner?.permissions.has(PermissionFlagsBits.Administrator)) {
        return owner;
    }

    const members = await guild.members.fetch();
    const adminMember =
        members.find((member) => !member.user.bot && member.permissions.has(PermissionFlagsBits.Administrator)) ||
        guild.members.me;

    if (!adminMember) {
        throw new Error("No administrator member was available for live setup validation.");
    }

    return adminMember;
}

async function resolveSetupChannel(guild: Guild, invoker: GuildMember) {
    const guildConfig = await getGuildConfig(guild.id);
    const candidateIds = [
        guildConfig?.channelIds?.logsId,
        guildConfig?.channelIds?.reportsId,
        guildConfig?.channelIds?.announcementsId,
        guildConfig?.channelIds?.supportId,
        guildConfig?.channelIds?.toolsId,
    ].filter(Boolean) as string[];

    const botMember = guild.members.me;
    if (!botMember) {
        throw new Error("Bot member is unavailable in the guild.");
    }

    for (const channelId of candidateIds) {
        const channel = await getTextChannel(guild, channelId);
        if (!channel) {
            continue;
        }

        const botPermissions = channel.permissionsFor(botMember);
        const invokerPermissions = channel.permissionsFor(invoker);
        if (
            botPermissions?.has([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageMessages,
            ]) &&
            invokerPermissions?.has(PermissionFlagsBits.ViewChannel)
        ) {
            return channel;
        }
    }

    const fallbackChannel = guild.channels.cache.find((channel) => {
        if (channel.type !== ChannelType.GuildText) {
            return false;
        }

        const textChannel = channel as TextChannel;
        const botPermissions = textChannel.permissionsFor(botMember);
        const invokerPermissions = textChannel.permissionsFor(invoker);
        return Boolean(
            botPermissions?.has([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageMessages,
            ]) && invokerPermissions?.has(PermissionFlagsBits.ViewChannel)
        );
    });

    if (!fallbackChannel || fallbackChannel.type !== ChannelType.GuildText) {
        throw new Error("No suitable text channel was available for live /setup validation.");
    }

    return fallbackChannel as TextChannel;
}

async function resolvePanelState(guild: Guild, panelRef: StoredPanelRef | null | undefined, kind: PanelKind): Promise<PanelState> {
    if (!panelRef?.channelId || !panelRef?.messageId) {
        return {
            channelId: null,
            channelName: null,
            messageId: null,
            messageExists: false,
            messagePinned: false,
            matchingMessageCount: 0,
            customIds: [],
        };
    }

    const channel = await getTextChannel(guild, panelRef.channelId);
    if (!channel) {
        return {
            channelId: panelRef.channelId,
            channelName: null,
            messageId: panelRef.messageId,
            messageExists: false,
            messagePinned: false,
            matchingMessageCount: 0,
            customIds: [],
        };
    }

    const message = await channel.messages.fetch(panelRef.messageId).catch(() => null);
    return {
        channelId: channel.id,
        channelName: channel.name,
        messageId: panelRef.messageId,
        messageExists: Boolean(message),
        messagePinned: message?.pinned ?? false,
        matchingMessageCount: await countMatchingPanelMessages(channel, panelCustomIds[kind]),
        customIds: message ? getMessageCustomIds(message) : [],
    };
}

async function runSetup(guild: Guild, member: GuildMember, channel: TextChannel): Promise<SetupRunResult> {
    const replies: string[] = [];

    await executeSetup({
        guild,
        member,
        channel,
        options: {
            getString(name: string) {
                return name === "mode" ? "normal" : null;
            },
        },
        async reply(payload: any) {
            replies.push(`reply:${payload?.embeds?.[0]?.data?.title || payload?.content || "unknown"}`);
            return null;
        },
        async editReply(payload: any) {
            replies.push(`editReply:${payload?.embeds?.[0]?.data?.title || payload?.content || "unknown"}`);
            return null;
        },
    } as any);

    return { replies };
}

async function main() {
    if (!config.token) {
        throw new Error("DISCORD_TOKEN is not configured.");
    }

    if (!config.guildId) {
        throw new Error("GUILD_ID is not configured.");
    }

    const databaseReady = await connectDatabase();
    if (!databaseReady) {
        throw new Error("Database connection failed before live setup validation.");
    }

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
        ],
    });

    try {
        await client.login(config.token);
        await new Promise<void>((resolve, reject) => {
            if (client.isReady()) {
                resolve();
                return;
            }

            const timeout = setTimeout(() => reject(new Error("Discord client did not become ready in time.")), 20_000);
            client.once("ready", () => {
                clearTimeout(timeout);
                resolve();
            });
        });

        const guild =
            client.guilds.cache.get(config.guildId) ||
            (await client.guilds.fetch(config.guildId).catch(() => null));
        if (!guild) {
            throw new Error(`Guild ${config.guildId} could not be fetched.`);
        }

        const hydratedGuild = "available" in guild ? guild : await guild.fetch();
        const invoker = await resolveInvoker(hydratedGuild);
        const setupChannel = await resolveSetupChannel(hydratedGuild, invoker);

        const beforeConfig = await getGuildConfig(hydratedGuild.id);
        console.log(
            JSON.stringify(
                {
                    phase: "before",
                    guildId: hydratedGuild.id,
                    setupChannelId: setupChannel.id,
                    setupChannelName: setupChannel.name,
                    panelRefs: beforeConfig?.toObject().panelRefs || null,
                },
                null,
                2
            )
        );

        const firstRun = await runSetup(hydratedGuild, invoker, setupChannel);
        const afterFirst = await getGuildConfig(hydratedGuild.id);
        if (!afterFirst) {
            throw new Error("GuildConfig was not available after the first /setup validation run.");
        }

        const firstStates = {
            setupWizard: await resolvePanelState(hydratedGuild, afterFirst.panelRefs?.setupWizard, "setupWizard"),
            verify: await resolvePanelState(hydratedGuild, afterFirst.panelRefs?.verify, "verify"),
            ticket: await resolvePanelState(hydratedGuild, afterFirst.panelRefs?.ticket, "ticket"),
        };

        const secondRun = await runSetup(hydratedGuild, invoker, setupChannel);
        const afterSecond = await getGuildConfig(hydratedGuild.id);
        if (!afterSecond) {
            throw new Error("GuildConfig was not available after the second /setup validation run.");
        }

        const secondStates = {
            setupWizard: await resolvePanelState(hydratedGuild, afterSecond.panelRefs?.setupWizard, "setupWizard"),
            verify: await resolvePanelState(hydratedGuild, afterSecond.panelRefs?.verify, "verify"),
            ticket: await resolvePanelState(hydratedGuild, afterSecond.panelRefs?.ticket, "ticket"),
        };

        const failures: string[] = [];
        for (const kind of Object.keys(firstStates) as PanelKind[]) {
            const firstState = firstStates[kind];
            const secondState = secondStates[kind];

            if (!firstState.messageExists) {
                failures.push(`${kind} panel reference does not resolve to a message after the first run.`);
            }
            if (!secondState.messageExists) {
                failures.push(`${kind} panel reference does not resolve to a message after the second run.`);
            }
            if (!firstState.messagePinned || !secondState.messagePinned) {
                failures.push(`${kind} panel message is not pinned after repeated setup runs.`);
            }
            if (secondState.matchingMessageCount > firstState.matchingMessageCount) {
                failures.push(
                    `${kind} panel count increased from ${firstState.matchingMessageCount} to ${secondState.matchingMessageCount} on repeated /setup.`
                );
            }
            if (!secondState.customIds.some((customId) => panelCustomIds[kind].includes(customId))) {
                failures.push(`${kind} panel message is missing the expected component custom IDs after repeated setup.`);
            }
        }

        console.log(
            JSON.stringify(
                {
                    phase: "validation",
                    firstRunReplies: firstRun.replies,
                    secondRunReplies: secondRun.replies,
                    panelRefsAfterFirst: afterFirst.toObject().panelRefs || null,
                    panelRefsAfterSecond: afterSecond.toObject().panelRefs || null,
                    firstStates,
                    secondStates,
                    repeatedSetupIdempotent: failures.length === 0,
                    failures,
                },
                null,
                2
            )
        );

        if (failures.length > 0) {
            throw new Error(`Live setup validation failed: ${failures.join(" ")}`);
        }
    } finally {
        await client.destroy();
        await mongoose.disconnect().catch(() => null);
    }
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
