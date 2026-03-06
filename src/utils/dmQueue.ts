import { GuildMember, EmbedBuilder } from "discord.js";

// Queue system to prevent Discord rate-limiting for Mass DMs
interface QueuedMessage {
    member: GuildMember;
    embed: EmbedBuilder;
}

const queue: QueuedMessage[] = [];
let isProcessing = false;

// Random jitter between 1500ms and 3000ms
function getDelay() {
    return Math.floor(Math.random() * 1500) + 1500;
}

export function queueDM(member: GuildMember, embed: EmbedBuilder) {
    queue.push({ member, embed });
    if (!isProcessing) {
        processQueue();
    }
}

async function processQueue() {
    if (queue.length === 0) {
        isProcessing = false;
        return;
    }

    isProcessing = true;
    const msg = queue.shift()!;

    try {
        await msg.member.send({ embeds: [msg.embed] });
    } catch (error) {
        // Ignore, user probably has DMs disabled
    }

    setTimeout(() => {
        processQueue();
    }, getDelay());
}
