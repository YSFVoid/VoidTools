import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    PermissionFlagsBits,
} from "discord.js";
import { Tool, GuildConfig } from "../database";
import { successEmbed, errorEmbed, primaryEmbed } from "../utils/embeds";

export const toolsCommands = [
    new SlashCommandBuilder()
        .setName("addtool")
        .setDescription("Add a new tool to the database")
        .addStringOption(o => o.setName("name").setDescription("Tool Name").setRequired(true))
        .addStringOption(o => o.setName("description").setDescription("Short description").setRequired(true))
        .addStringOption(o => o.setName("category").setDescription("Category").setRequired(true))
        .addStringOption(o => o.setName("version").setDescription("Version (e.g. 1.0.0)").setRequired(false))
        .addStringOption(o => o.setName("url").setDescription("Download/Homepage URL").setRequired(false)),

    new SlashCommandBuilder()
        .setName("removetool")
        .setDescription("Remove a tool")
        .addStringOption(o => o.setName("name").setDescription("Tool Name").setRequired(true)),

    new SlashCommandBuilder()
        .setName("edittool")
        .setDescription("Edit an existing tool")
        .addStringOption(o => o.setName("name").setDescription("Tool Name").setRequired(true))
        .addStringOption(o => o.setName("description").setDescription("Short description").setRequired(false))
        .addStringOption(o => o.setName("version").setDescription("Version").setRequired(false))
        .addStringOption(o => o.setName("url").setDescription("Download/Homepage URL").setRequired(false)),
];

export async function handleToolsAdmin(interaction: ChatInputCommandInteraction) {
    const gConf = await GuildConfig.findOne({ guildId: interaction.guildId });
    // Staff checking
    const memRoles = (interaction.member as any).roles.cache;
    const isStaff = memRoles.has(gConf?.roleIds?.adminRoleId) || memRoles.has(gConf?.roleIds?.modRoleId);
    if (!isStaff && interaction.user.id !== interaction.guild?.ownerId) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], ephemeral: true });
    }

    if (interaction.commandName === "addtool") {
        const name = interaction.options.getString("name", true);
        const desc = interaction.options.getString("description", true);
        const cat = interaction.options.getString("category", true);
        const version = interaction.options.getString("version") || "1.0.0";
        const url = interaction.options.getString("url") || "None";

        const exists = await Tool.findOne({ name: { $regex: new RegExp(`^${name}$`, "i") } });
        if (exists) return interaction.reply({ embeds: [errorEmbed("Exists", "Tool with this name already exists.")], ephemeral: true });

        const tool = new Tool({
            name, description: desc, category: cat, version, url, addedBy: interaction.user.id
        });
        await tool.save();
        await interaction.reply({ embeds: [successEmbed("Tool Added", `**${name}** has been added to the hub.`)] });
    }

    if (interaction.commandName === "removetool") {
        const name = interaction.options.getString("name", true);
        const deleted = await Tool.findOneAndDelete({ name: { $regex: new RegExp(`^${name}$`, "i") } });
        if (!deleted) return interaction.reply({ embeds: [errorEmbed("Not Found", `Tool **${name}** not found.`)] });
        await interaction.reply({ embeds: [successEmbed("Deleted", `**${deleted.name}** was removed.`)] });
    }

    if (interaction.commandName === "edittool") {
        const name = interaction.options.getString("name", true);
        const desc = interaction.options.getString("description");
        const version = interaction.options.getString("version");
        const url = interaction.options.getString("url");

        const tool = await Tool.findOne({ name: { $regex: new RegExp(`^${name}$`, "i") } });
        if (!tool) return interaction.reply({ embeds: [errorEmbed("Not Found", `Tool **${name}** not found.`)] });

        if (desc) tool.description = desc;
        if (version) tool.version = version;
        if (url) tool.url = url;

        await tool.save();
        await interaction.reply({ embeds: [successEmbed("Updated", `**${tool.name}** has been updated.`)] });
    }
}
