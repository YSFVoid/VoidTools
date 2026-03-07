import { GuildMember, PermissionsBitField, Role } from "discord.js";
import { getGuildConfig } from "../database";

export async function isStaff(member: GuildMember): Promise<boolean> {
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;

    const gConf = await getGuildConfig(member.guild.id);
    if (!gConf || !gConf.roleIds) return false;

    const staffRoles = [
        gConf.roleIds.adminRoleId,
        gConf.roleIds.modRoleId,
        gConf.roleIds.supportRoleId,
    ];

    for (const roleId of staffRoles) {
        if (roleId && member.roles.cache.has(roleId)) return true;
    }
    return false;
}

export async function isAdmin(member: GuildMember): Promise<boolean> {
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;

    const gConf = await getGuildConfig(member.guild.id);
    if (!gConf || !gConf.roleIds || !gConf.roleIds.adminRoleId) return false;

    return member.roles.cache.has(gConf.roleIds.adminRoleId);
}

export async function getRoleSafely(member: GuildMember, roleId: string | undefined): Promise<Role | null> {
    if (!roleId) return null;
    return member.guild.roles.cache.get(roleId) || null;
}
