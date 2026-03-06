import { TextChannel, Collection, Message, AttachmentBuilder } from "discord.js";

export async function generateTranscript(channel: TextChannel, limit: number = 200): Promise<AttachmentBuilder | null> {
    try {
        let messages: Message[] = [];
        let lastId: string | undefined = undefined;

        while (messages.length < limit) {
            const options: import("discord.js").FetchMessagesOptions = { limit: Math.min(100, limit - messages.length) };
            if (lastId) options.before = lastId;

            const fetched = await channel.messages.fetch(options);
            if (fetched.size === 0) break;

            messages = messages.concat(Array.from(fetched.values()));
            lastId = fetched.last()?.id;
        }

        // Sort chronologically
        messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        let transcript = `Transcript for ${channel.name}\nGenerated at ${new Date().toISOString()}\n\n`;

        for (const msg of messages) {
            if (msg.author.bot) continue; // Optional: include or exclude bot messages
            const time = new Date(msg.createdTimestamp).toLocaleString();
            transcript += `[${time}] ${msg.author.tag} (${msg.author.id}):\n${msg.content}\n`;

            if (msg.attachments.size > 0) {
                transcript += `[Attachments: ${msg.attachments.map(a => a.url).join(", ")}]\n`;
            }
            transcript += "----------------------------------------\n";
        }

        return new AttachmentBuilder(Buffer.from(transcript, "utf-8"), { name: `${channel.name}-transcript.txt` });
    } catch (error) {
        console.error("Failed to generate transcript:", error);
        return null;
    }
}
