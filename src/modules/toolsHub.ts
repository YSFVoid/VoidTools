import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    ChatInputCommandInteraction,
    EmbedBuilder,
    SlashCommandBuilder,
} from "discord.js";
import { Tool } from "../database";
import { errorEmbed, successEmbed } from "../utils/embeds";
import { isStaff } from "../utils/permissions";
import { escapeRegExp } from "../utils/regex";
import { normalizeHttpUrl } from "../utils/urls";

interface ToolDraft {
    name: string;
    description: string;
    category: string;
    version: string | null;
    sourceUrl: string | null;
    downloadUrl: string | null;
    imageUrl: string | null;
    thumbnailUrl: string | null;
}

function isSupportedPostChannel(channel: unknown): channel is { id: string; send: (...args: any[]) => Promise<any> } {
    if (!channel || typeof channel !== "object") {
        return false;
    }

    const candidate = channel as { type?: ChannelType; send?: (...args: any[]) => Promise<any> };
    return (
        typeof candidate.send === "function" &&
        (candidate.type === ChannelType.GuildText || candidate.type === ChannelType.GuildAnnouncement)
    );
}

export const toolsCommands = [
    new SlashCommandBuilder()
        .setName("addtool")
        .setDescription("Add a new tool to the database")
        .setDMPermission(false)
        .addStringOption((option) => option.setName("name").setDescription("Tool name").setRequired(true))
        .addStringOption((option) => option.setName("description").setDescription("Short description").setRequired(true))
        .addStringOption((option) => option.setName("category").setDescription("Category").setRequired(true))
        .addStringOption((option) => option.setName("version").setDescription("Version").setRequired(false))
        .addStringOption((option) => option.setName("source_url").setDescription("Source code URL").setRequired(false))
        .addStringOption((option) => option.setName("download_url").setDescription("Download URL").setRequired(false))
        .addStringOption((option) => option.setName("image_url").setDescription("Large image URL").setRequired(false))
        .addStringOption((option) => option.setName("thumbnail_url").setDescription("Thumbnail URL").setRequired(false)),

    new SlashCommandBuilder()
        .setName("removetool")
        .setDescription("Remove a tool from the database")
        .setDMPermission(false)
        .addStringOption((option) => option.setName("name").setDescription("Tool name").setRequired(true)),

    new SlashCommandBuilder()
        .setName("edittool")
        .setDescription("Edit an existing tool in the database")
        .setDMPermission(false)
        .addStringOption((option) => option.setName("name").setDescription("Tool name").setRequired(true))
        .addStringOption((option) => option.setName("description").setDescription("Short description").setRequired(false))
        .addStringOption((option) => option.setName("category").setDescription("Category").setRequired(false))
        .addStringOption((option) => option.setName("version").setDescription("Version").setRequired(false))
        .addStringOption((option) => option.setName("source_url").setDescription("Source code URL").setRequired(false))
        .addStringOption((option) => option.setName("download_url").setDescription("Download URL").setRequired(false))
        .addStringOption((option) => option.setName("image_url").setDescription("Large image URL").setRequired(false))
        .addStringOption((option) => option.setName("thumbnail_url").setDescription("Thumbnail URL").setRequired(false)),

    new SlashCommandBuilder()
        .setName("posttool")
        .setDescription("Post a professional tool announcement to a selected channel")
        .setDMPermission(false)
        .addChannelOption((option) =>
            option
                .setName("channel")
                .setDescription("Channel to post the announcement in")
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true)
        )
        .addStringOption((option) => option.setName("name").setDescription("Tool name").setRequired(true))
        .addStringOption((option) => option.setName("description").setDescription("Tool description").setRequired(true))
        .addStringOption((option) => option.setName("category").setDescription("Tool category").setRequired(true))
        .addStringOption((option) => option.setName("source_url").setDescription("Source code URL").setRequired(true))
        .addStringOption((option) => option.setName("download_url").setDescription("Download URL").setRequired(true))
        .addStringOption((option) => option.setName("version").setDescription("Version").setRequired(false))
        .addStringOption((option) => option.setName("image_url").setDescription("Large image URL").setRequired(false))
        .addStringOption((option) => option.setName("thumbnail_url").setDescription("Thumbnail URL").setRequired(false))
        .addBooleanOption((option) =>
            option
                .setName("store_in_database")
                .setDescription("Store or update the tool in the database")
                .setRequired(false)
        ),
];

async function findToolByName(name: string) {
    return Tool.findOne({ name: { $regex: new RegExp(`^${escapeRegExp(name)}$`, "i") } });
}

function getOptionalString(interaction: ChatInputCommandInteraction, name: string) {
    return interaction.options.getString(name)?.trim() || null;
}

function validateOptionalUrl(value: string | null, fieldName: string) {
    if (!value) {
        return { value: null, error: null };
    }

    return normalizeHttpUrl(value, fieldName);
}

function buildToolDraft(
    interaction: ChatInputCommandInteraction,
    options: { requireLinks: boolean }
): { draft: ToolDraft | null; error: string | null } {
    const sourceUrl = getOptionalString(interaction, "source_url");
    const downloadUrl = getOptionalString(interaction, "download_url");
    const imageUrl = getOptionalString(interaction, "image_url");
    const thumbnailUrl = getOptionalString(interaction, "thumbnail_url");

    const normalizedSourceUrl = options.requireLinks
        ? normalizeHttpUrl(sourceUrl || "", "Source URL")
        : validateOptionalUrl(sourceUrl, "Source URL");
    if (normalizedSourceUrl.error) {
        return { draft: null, error: normalizedSourceUrl.error };
    }

    const normalizedDownloadUrl = options.requireLinks
        ? normalizeHttpUrl(downloadUrl || "", "Download URL")
        : validateOptionalUrl(downloadUrl, "Download URL");
    if (normalizedDownloadUrl.error) {
        return { draft: null, error: normalizedDownloadUrl.error };
    }

    const normalizedImageUrl = validateOptionalUrl(imageUrl, "Image URL");
    if (normalizedImageUrl.error) {
        return { draft: null, error: normalizedImageUrl.error };
    }

    const normalizedThumbnailUrl = validateOptionalUrl(thumbnailUrl, "Thumbnail URL");
    if (normalizedThumbnailUrl.error) {
        return { draft: null, error: normalizedThumbnailUrl.error };
    }

    return {
        draft: {
            name: interaction.options.getString("name", true).trim(),
            description: interaction.options.getString("description", true).trim(),
            category: interaction.options.getString("category", true).trim(),
            version: getOptionalString(interaction, "version"),
            sourceUrl: normalizedSourceUrl.value,
            downloadUrl: normalizedDownloadUrl.value,
            imageUrl: normalizedImageUrl.value,
            thumbnailUrl: normalizedThumbnailUrl.value,
        },
        error: null,
    };
}

function buildToolAnnouncementEmbed(tool: ToolDraft) {
    const descriptionLines = [tool.description];
    if (tool.sourceUrl) {
        descriptionLines.push(`Source Code: ${tool.sourceUrl}`);
    }
    if (tool.downloadUrl) {
        descriptionLines.push(`Download: ${tool.downloadUrl}`);
    }

    const embed = new EmbedBuilder()
        .setTitle(tool.name)
        .setDescription(descriptionLines.join("\n\n"))
        .setColor(0x7b2fbe)
        .addFields(
            { name: "Category", value: tool.category, inline: true },
            { name: "Version", value: tool.version || "Latest", inline: true }
        )
        .setTimestamp()
        .setFooter({ text: "Developed by Ysf (Lone Wolf Developer)" });

    if (tool.sourceUrl) {
        embed.addFields({ name: "Source Code", value: tool.sourceUrl, inline: false });
    }

    if (tool.downloadUrl) {
        embed.addFields({ name: "Download", value: tool.downloadUrl, inline: false });
    }

    if (tool.thumbnailUrl) {
        embed.setThumbnail(tool.thumbnailUrl);
    }

    if (tool.imageUrl) {
        embed.setImage(tool.imageUrl);
    }

    return embed;
}

function buildToolButtons(tool: ToolDraft) {
    const buttons: ButtonBuilder[] = [];

    if (tool.sourceUrl) {
        buttons.push(
            new ButtonBuilder()
                .setStyle(ButtonStyle.Link)
                .setLabel("Source Code")
                .setURL(tool.sourceUrl)
        );
    }

    if (tool.downloadUrl) {
        buttons.push(
            new ButtonBuilder()
                .setStyle(ButtonStyle.Link)
                .setLabel("Download")
                .setURL(tool.downloadUrl)
        );
    }

    return buttons.length > 0
        ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)]
        : [];
}

async function upsertToolRecord(draft: ToolDraft, actorId: string) {
    const existingTool = await findToolByName(draft.name);
    const tool = existingTool || new Tool({ name: draft.name, addedBy: actorId });
    const wasCreated = !existingTool;

    tool.name = draft.name;
    tool.description = draft.description;
    tool.category = draft.category;
    tool.version = draft.version || tool.version || "Latest";
    tool.sourceUrl = draft.sourceUrl || tool.sourceUrl || "";
    tool.downloadUrl = draft.downloadUrl || tool.downloadUrl || "";
    tool.url = draft.downloadUrl || tool.url || "";
    tool.imageUrl = draft.imageUrl || tool.imageUrl || "";
    tool.thumbnailUrl = draft.thumbnailUrl || tool.thumbnailUrl || "";

    await tool.save();
    return { tool, wasCreated };
}

export async function handleToolsAdmin(interaction: ChatInputCommandInteraction) {
    if (!(await isStaff(interaction.member as any)) && interaction.user.id !== interaction.guild?.ownerId) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], ephemeral: true });
    }

    if (interaction.commandName === "addtool") {
        const result = buildToolDraft(interaction, { requireLinks: false });
        if (result.error || !result.draft) {
            return interaction.reply({ embeds: [errorEmbed("Invalid Input", result.error || "Invalid tool input.")], ephemeral: true });
        }

        const existingTool = await findToolByName(result.draft.name);
        if (existingTool) {
            return interaction.reply({
                embeds: [errorEmbed("Exists", "A tool with this name already exists. Use `/edittool` or `/posttool`.")],
                ephemeral: true,
            });
        }

        await upsertToolRecord(result.draft, interaction.user.id);
        await interaction.reply({ embeds: [successEmbed("Tool Added", `**${result.draft.name}** has been added to the hub.`)] });
        return;
    }

    if (interaction.commandName === "removetool") {
        const name = interaction.options.getString("name", true).trim();
        const deleted = await Tool.findOneAndDelete({ name: { $regex: new RegExp(`^${escapeRegExp(name)}$`, "i") } });
        if (!deleted) {
            return interaction.reply({ embeds: [errorEmbed("Not Found", `Tool **${name}** was not found.`)], ephemeral: true });
        }

        await interaction.reply({ embeds: [successEmbed("Deleted", `**${deleted.name}** was removed from the database.`)] });
        return;
    }

    if (interaction.commandName === "edittool") {
        const existingTool = await findToolByName(interaction.options.getString("name", true).trim());
        if (!existingTool) {
            return interaction.reply({ embeds: [errorEmbed("Not Found", "Tool not found in the database.")], ephemeral: true });
        }

        const updatedDescription = getOptionalString(interaction, "description");
        const updatedCategory = getOptionalString(interaction, "category");
        const updatedVersion = getOptionalString(interaction, "version");
        const updatedSourceUrl = validateOptionalUrl(getOptionalString(interaction, "source_url"), "Source URL");
        const updatedDownloadUrl = validateOptionalUrl(getOptionalString(interaction, "download_url"), "Download URL");
        const updatedImageUrl = validateOptionalUrl(getOptionalString(interaction, "image_url"), "Image URL");
        const updatedThumbnailUrl = validateOptionalUrl(getOptionalString(interaction, "thumbnail_url"), "Thumbnail URL");

        const firstError = [
            updatedSourceUrl.error,
            updatedDownloadUrl.error,
            updatedImageUrl.error,
            updatedThumbnailUrl.error,
        ].find(Boolean);
        if (firstError) {
            return interaction.reply({ embeds: [errorEmbed("Invalid Input", firstError)], ephemeral: true });
        }

        if (updatedDescription) existingTool.description = updatedDescription;
        if (updatedCategory) existingTool.category = updatedCategory;
        if (updatedVersion) existingTool.version = updatedVersion;
        if (updatedSourceUrl.value) existingTool.sourceUrl = updatedSourceUrl.value;
        if (updatedDownloadUrl.value) {
            existingTool.downloadUrl = updatedDownloadUrl.value;
            existingTool.url = updatedDownloadUrl.value;
        }
        if (updatedImageUrl.value) existingTool.imageUrl = updatedImageUrl.value;
        if (updatedThumbnailUrl.value) existingTool.thumbnailUrl = updatedThumbnailUrl.value;

        await existingTool.save();
        await interaction.reply({ embeds: [successEmbed("Updated", `**${existingTool.name}** has been updated.`)] });
        return;
    }

    if (interaction.commandName === "posttool") {
        const result = buildToolDraft(interaction, { requireLinks: true });
        if (result.error || !result.draft) {
            return interaction.reply({ embeds: [errorEmbed("Invalid Input", result.error || "Invalid tool input.")], ephemeral: true });
        }

        const targetChannel = interaction.options.getChannel("channel", true);
        if (!isSupportedPostChannel(targetChannel)) {
            return interaction.reply({ embeds: [errorEmbed("Invalid Channel", "Choose a server text or announcement channel.")], ephemeral: true });
        }

        const storeInDatabase = interaction.options.getBoolean("store_in_database") ?? true;

        await interaction.deferReply({ ephemeral: true });

        const embed = buildToolAnnouncementEmbed(result.draft);
        const components = buildToolButtons(result.draft);

        try {
            const message = await targetChannel.send({ embeds: [embed], components });

            let databaseSummary = "Posted without storing in the database.";
            if (storeInDatabase) {
                const saved = await upsertToolRecord(result.draft, interaction.user.id);
                saved.tool.publishedChannelId = targetChannel.id;
                saved.tool.publishedMessageId = message.id;
                saved.tool.lastPostedAt = new Date();
                await saved.tool.save();

                databaseSummary = saved.wasCreated
                    ? "Tool stored in the database."
                    : "Existing tool record updated in the database.";
            }

            await interaction.editReply({
                embeds: [
                    successEmbed(
                        "Tool Posted",
                        `Posted **${result.draft.name}** in <#${targetChannel.id}>.\n${databaseSummary}\nMessage: ${message.url}`
                    ),
                ],
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await interaction.editReply({
                embeds: [errorEmbed("Post Failed", `I could not post the tool announcement. ${message}`)],
            });
        }
    }
}
