import { ChannelType, Message, TextChannel } from "discord.js";

export interface PanelRef {
    channelId: string;
    messageId: string;
}

interface PanelPayload {
    content?: string;
    embeds?: any[];
    components?: any[];
}

function messageHasAnyCustomId(message: Message, customIds: string[]) {
    return message.components.some((row: any) =>
        Array.isArray(row.components) &&
        row.components.some(
            (component: any) => typeof component.customId === "string" && customIds.includes(component.customId)
        )
    );
}

async function fetchPanelMessage(channel: TextChannel, messageId: string, customIds: string[]) {
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message || !messageHasAnyCustomId(message, customIds)) {
        return null;
    }

    return message;
}

async function findPanelMessageInChannel(channel: TextChannel, customIds: string[]) {
    const pinnedMessages = await channel.messages.fetchPinned().catch(() => null);
    const pinnedMatch = pinnedMessages?.find((message) => messageHasAnyCustomId(message, customIds));
    if (pinnedMatch) {
        return pinnedMatch;
    }

    const recentMessages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    return recentMessages?.find((message) => messageHasAnyCustomId(message, customIds)) || null;
}

export async function ensurePanelMessage(
    targetChannel: TextChannel,
    customIds: string[],
    payload: PanelPayload,
    existingRef?: PanelRef | null
) {
    let existingMessage: Message | null = null;

    if (existingRef?.channelId && existingRef?.messageId) {
        const existingChannel =
            existingRef.channelId === targetChannel.id
                ? targetChannel
                : ((targetChannel.guild.channels.cache.get(existingRef.channelId) ||
                    (await targetChannel.guild.channels.fetch(existingRef.channelId).catch(() => null))) as TextChannel | null);

        if (existingChannel?.type === ChannelType.GuildText) {
            existingMessage = await fetchPanelMessage(existingChannel, existingRef.messageId, customIds);
        }
    }

    if (!existingMessage) {
        existingMessage = await findPanelMessageInChannel(targetChannel, customIds);
    }

    if (existingMessage) {
        await existingMessage.edit(payload).catch(() => null);
        await existingMessage.pin().catch(() => null);
        return {
            channelId: existingMessage.channelId,
            messageId: existingMessage.id,
            created: false,
        };
    }

    const message = await targetChannel.send(payload);
    await message.pin().catch(() => null);
    return {
        channelId: message.channelId,
        messageId: message.id,
        created: true,
    };
}
