import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    ChatInputCommandInteraction,
    Client,
    EmbedBuilder,
    Guild,
    MessageFlags,
    SlashCommandBuilder,
} from "discord.js";
import { config } from "../config";
import { getGuildConfig, isDatabaseReady, ReleaseFeed } from "../database";
import { markJobFinished, markJobOffline, markJobStarted } from "../runtime";
import { errorEmbed, primaryEmbed, successEmbed } from "../utils/embeds";
import { isStaff } from "../utils/permissions";
import { parseGitHubRepoInput } from "../utils/urls";

let releasesPollerStarted = false;
let activeReleasePoll: Promise<void> | null = null;

interface GitHubRepositoryResponse {
    full_name: string;
    html_url: string;
    default_branch: string;
}

interface GitHubReleaseResponse {
    id: number;
    html_url: string;
    name: string | null;
    tag_name: string;
    body: string | null;
    published_at: string | null;
}

interface GitHubCommitResponse {
    sha: string;
    html_url: string;
    commit: {
        message: string;
        author: {
            name: string;
            date: string;
        };
    };
    author?: {
        login: string;
    } | null;
}

export const githubWatchCommands = [
    new SlashCommandBuilder()
        .setName("githubwatch")
        .setDescription("Manage GitHub repository notifications")
        .setDMPermission(false)
        .addSubcommand((sub) =>
            sub
                .setName("add")
                .setDescription("Add or update a GitHub watcher")
                .addStringOption((option) =>
                    option
                        .setName("repo_url")
                        .setDescription("GitHub repository URL")
                        .setRequired(true)
                )
                .addStringOption((option) =>
                    option
                        .setName("updates")
                        .setDescription("Which updates should be announced")
                        .addChoices(
                            { name: "Releases", value: "releases" },
                            { name: "Commits", value: "commits" },
                            { name: "Both", value: "both" }
                        )
                        .setRequired(true)
                )
                .addChannelOption((option) =>
                    option
                        .setName("target_channel")
                        .setDescription("Channel that should receive notifications")
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("remove")
                .setDescription("Remove a GitHub watcher")
                .addStringOption((option) =>
                    option
                        .setName("repo_url")
                        .setDescription("GitHub repository URL")
                        .setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("list")
                .setDescription("List configured GitHub watchers")
        )
        .addSubcommand((sub) =>
            sub
                .setName("test")
                .setDescription("Send a test notification for a watched repository")
                .addStringOption((option) =>
                    option
                        .setName("repo_url")
                        .setDescription("GitHub repository URL")
                        .setRequired(true)
                )
        ),
];

function getGitHubHeaders() {
    const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "VoidToolsBot/2.0",
    };

    if (config.githubToken) {
        headers.Authorization = `Bearer ${config.githubToken}`;
    }

    return headers;
}

async function fetchGitHubJson<T>(path: string) {
    const response = await fetch(`https://api.github.com${path}`, {
        headers: getGitHubHeaders(),
    });

    if (response.status === 404) {
        return null as T | null;
    }

    if (!response.ok) {
        const message = await response.text();
        throw new Error(`GitHub API request failed (${response.status}): ${message.slice(0, 200)}`);
    }

    return response.json() as Promise<T>;
}

function summarizeText(value: string | null | undefined, maxLength = 320) {
    const cleaned = (value || "")
        .replace(/\r/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    if (!cleaned) {
        return "No summary provided.";
    }

    return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 3)}...` : cleaned;
}

function getWatchLabel(watch: any) {
    if (watch.watchReleases && watch.watchCommits) {
        return "releases + commits";
    }

    if (watch.watchCommits) {
        return "commits";
    }

    return "releases";
}

function isSupportedGitHubChannel(channel: unknown): channel is { id: string; send: (...args: any[]) => Promise<any> } {
    if (!channel || typeof channel !== "object") {
        return false;
    }

    const candidate = channel as { type?: ChannelType; send?: (...args: any[]) => Promise<any> };
    return (
        typeof candidate.send === "function" &&
        (candidate.type === ChannelType.GuildText || candidate.type === ChannelType.GuildAnnouncement)
    );
}

async function findGitHubWatchDocument(guildId: string, parsedRepo: { fullName: string; repoUrl: string }) {
    return ReleaseFeed.findOne({
        guildId,
        $or: [
            { repoFullName: parsedRepo.fullName },
            { repoUrl: parsedRepo.repoUrl },
            { url: parsedRepo.repoUrl },
            { url: `${parsedRepo.repoUrl}/releases` },
            { url: `${parsedRepo.repoUrl}/releases.atom` },
        ],
    });
}

async function fetchRepository(fullName: string) {
    return fetchGitHubJson<GitHubRepositoryResponse>(`/repos/${fullName}`);
}

async function fetchLatestRelease(fullName: string) {
    const releases = await fetchGitHubJson<GitHubReleaseResponse[]>(`/repos/${fullName}/releases?per_page=1`);
    return releases?.[0] || null;
}

async function fetchLatestCommit(fullName: string, branch: string) {
    const commits = await fetchGitHubJson<GitHubCommitResponse[]>(
        `/repos/${fullName}/commits?sha=${encodeURIComponent(branch)}&per_page=1`
    );
    return commits?.[0] || null;
}

async function hydrateWatchRecord(watch: any) {
    if (watch.repoFullName && watch.repoUrl) {
        return watch;
    }

    const parsed = parseGitHubRepoInput(watch.repoUrl || watch.url || "");
    if (!parsed) {
        return null;
    }

    watch.repoUrl = parsed.repoUrl;
    watch.repoOwner = parsed.owner;
    watch.repoName = parsed.repo;
    watch.repoFullName = parsed.fullName;
    watch.url = parsed.repoUrl;

    return watch;
}

function buildReleaseEmbed(repository: GitHubRepositoryResponse, release: GitHubReleaseResponse) {
    const embed = new EmbedBuilder()
        .setTitle(`GitHub Release: ${release.name || release.tag_name}`)
        .setURL(release.html_url)
        .setDescription(summarizeText(release.body))
        .setColor(config.colors.primary)
        .addFields(
            { name: "Repository", value: repository.full_name, inline: true },
            { name: "Tag", value: release.tag_name, inline: true }
        )
        .setTimestamp(release.published_at ? new Date(release.published_at) : new Date())
        .setFooter({ text: config.credits });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Open Repository").setURL(repository.html_url),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("View Release").setURL(release.html_url)
    );

    return { embed, components: [row] };
}

function buildCommitEmbed(repository: GitHubRepositoryResponse, commit: GitHubCommitResponse, branch: string, previousSha?: string | null) {
    const [summaryLine] = commit.commit.message.split("\n");
    const compareUrl =
        previousSha && previousSha !== commit.sha
            ? `${repository.html_url}/compare/${previousSha}...${commit.sha}`
            : commit.html_url;

    const embed = new EmbedBuilder()
        .setTitle(`GitHub Commit: ${summaryLine}`)
        .setURL(compareUrl)
        .setDescription(summarizeText(commit.commit.message))
        .setColor(config.colors.info)
        .addFields(
            { name: "Repository", value: repository.full_name, inline: true },
            { name: "Author", value: commit.author?.login || commit.commit.author.name, inline: true },
            { name: "Branch", value: branch, inline: true }
        )
        .setTimestamp(new Date(commit.commit.author.date))
        .setFooter({ text: config.credits });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Open Repository").setURL(repository.html_url),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("View Commit").setURL(compareUrl)
    );

    return { embed, components: [row] };
}

async function sendWatchPayload(guild: Guild, channelId: string, payload: { embed: EmbedBuilder; components: ActionRowBuilder<ButtonBuilder>[] }) {
    const channel = guild.channels.cache.get(channelId) || (await guild.channels.fetch(channelId).catch(() => null));
    if (!isSupportedGitHubChannel(channel)) {
        throw new Error(`GitHub notification channel ${channelId} is missing or not postable.`);
    }

    return channel.send({ embeds: [payload.embed], components: payload.components });
}

async function seedWatchState(watch: any, repository: GitHubRepositoryResponse) {
    if (watch.watchReleases && !watch.lastReleaseId) {
        const release = await fetchLatestRelease(repository.full_name);
        if (release) {
            watch.lastReleaseId = String(release.id);
            watch.lastReleasePublishedAt = release.published_at ? new Date(release.published_at) : new Date();
        }
    }

    if (watch.watchCommits && !watch.lastCommitSha) {
        const branch = watch.defaultBranch || repository.default_branch;
        const commit = await fetchLatestCommit(repository.full_name, branch);
        if (commit) {
            watch.lastCommitSha = commit.sha;
            watch.lastCommitPublishedAt = new Date(commit.commit.author.date);
        }
    }
}

export async function handleGitHubWatchAdmin(interaction: ChatInputCommandInteraction) {
    if (!(await isStaff(interaction.member as any)) && interaction.user.id !== interaction.guild?.ownerId) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], flags: MessageFlags.Ephemeral });
    }

    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    if (!guildId) {
        return interaction.reply({ embeds: [errorEmbed("Guild Only", "This command only works in a server.")], flags: MessageFlags.Ephemeral });
    }

    if (subcommand === "list") {
        const watches = await ReleaseFeed.find({ guildId });
        if (watches.length === 0) {
            return interaction.reply({ embeds: [primaryEmbed("GitHub Watchers", "No repositories are being watched yet.")], flags: MessageFlags.Ephemeral });
        }

        const lines = watches.map((watch) => {
            const parsed = parseGitHubRepoInput(watch.repoUrl || watch.url || "");
            const targetChannelId = watch.targetChannelId || "Not configured";
            return `- ${(watch.repoFullName || parsed?.fullName || watch.repoUrl || watch.url)} | ${getWatchLabel(watch)} | ${
                targetChannelId === "Not configured" ? targetChannelId : `<#${targetChannelId}>`
            }`;
        });

        return interaction.reply({ embeds: [primaryEmbed("GitHub Watchers", lines.join("\n"))], flags: MessageFlags.Ephemeral });
    }

    const repoInput = interaction.options.getString("repo_url", true);
    const parsedRepo = parseGitHubRepoInput(repoInput);
    if (!parsedRepo) {
        return interaction.reply({ embeds: [errorEmbed("Invalid Repository", "Use a valid public GitHub repository URL.")], flags: MessageFlags.Ephemeral });
    }

    if (subcommand === "remove") {
        const existingWatch = await findGitHubWatchDocument(guildId, parsedRepo);
        if (!existingWatch) {
            return interaction.reply({ embeds: [errorEmbed("Not Found", "No watcher exists for that repository.")], flags: MessageFlags.Ephemeral });
        }

        await existingWatch.deleteOne();
        return interaction.reply({
            embeds: [successEmbed("Watcher Removed", `Stopped watching **${parsedRepo.fullName}**.`)],
            flags: MessageFlags.Ephemeral,
        });
    }

    try {
        const repository = await fetchRepository(parsedRepo.fullName);
        if (!repository) {
            return interaction.reply({
                embeds: [errorEmbed("Repository Not Found", "GitHub did not return that public repository.")],
                flags: MessageFlags.Ephemeral,
            });
        }

        if (subcommand === "test") {
            const watch = await findGitHubWatchDocument(guildId, parsedRepo);
            if (!watch) {
                return interaction.reply({ embeds: [errorEmbed("Not Found", "Create the watcher first with `/githubwatch add`.")], flags: MessageFlags.Ephemeral });
            }

            const guild = interaction.guild;
            if (!guild) {
                return interaction.reply({ embeds: [errorEmbed("Guild Only", "This command only works in a server.")], flags: MessageFlags.Ephemeral });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const branch = watch.defaultBranch || parsedRepo.branch || repository.default_branch;
            const guildConfig = await getGuildConfig(guildId);
            const targetChannelId = watch.targetChannelId || guildConfig?.channelIds?.toolReleasesId;
            if (!targetChannelId) {
                return interaction.editReply({
                    embeds: [errorEmbed("No Channel Configured", "Set a target channel with `/githubwatch add` before sending a test.")],
                });
            }

            let sentCount = 0;

            if (watch.watchReleases) {
                const release = await fetchLatestRelease(repository.full_name);
                if (release) {
                    const sentMessage = await sendWatchPayload(guild, targetChannelId, buildReleaseEmbed(repository, release));
                    if (sentMessage) {
                        sentCount += 1;
                    }
                }
            }

            if (watch.watchCommits) {
                const commit = await fetchLatestCommit(repository.full_name, branch);
                if (commit) {
                    const sentMessage = await sendWatchPayload(
                        guild,
                        targetChannelId,
                        buildCommitEmbed(repository, commit, branch, watch.lastCommitSha || null)
                    );
                    if (sentMessage) {
                        sentCount += 1;
                    }
                }
            }

            if (sentCount === 0) {
                return interaction.editReply({ embeds: [errorEmbed("No Test Sent", "No release or commit was available to test with.")] });
            }

            return interaction.editReply({
                embeds: [successEmbed("Test Sent", `Sent ${sentCount} GitHub notification(s) for **${repository.full_name}**.`)],
            });
        }

        const targetChannel = interaction.options.getChannel("target_channel", true);
        if (!isSupportedGitHubChannel(targetChannel)) {
            return interaction.reply({ embeds: [errorEmbed("Invalid Channel", "Choose a server text or announcement channel.")], flags: MessageFlags.Ephemeral });
        }

        const updates = interaction.options.getString("updates", true);
        const watchReleases = updates === "releases" || updates === "both";
        const watchCommits = updates === "commits" || updates === "both";

        const existingWatch = await findGitHubWatchDocument(guildId, parsedRepo);
        const watch = existingWatch || new ReleaseFeed({ guildId, addedBy: interaction.user.id });

        watch.url = parsedRepo.repoUrl;
        watch.repoUrl = parsedRepo.repoUrl;
        watch.repoOwner = parsedRepo.owner;
        watch.repoName = parsedRepo.repo;
        watch.repoFullName = parsedRepo.fullName;
        watch.targetChannelId = targetChannel.id;
        watch.watchReleases = watchReleases;
        watch.watchCommits = watchCommits;
        watch.defaultBranch = parsedRepo.branch || repository.default_branch;

        await seedWatchState(watch, repository);
        await watch.save();

        return interaction.reply({
            embeds: [
                successEmbed(
                    existingWatch ? "Watcher Updated" : "Watcher Added",
                    `Repository: **${repository.full_name}**\nUpdates: **${getWatchLabel(watch)}**\nChannel: <#${targetChannel.id}>`
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.deferred || interaction.replied) {
            return interaction.editReply({ embeds: [errorEmbed("GitHub Watch Failed", message)] });
        }

        return interaction.reply({ embeds: [errorEmbed("GitHub Watch Failed", message)], flags: MessageFlags.Ephemeral });
    }
}

async function runGitHubPoll(client: Client) {
    markJobStarted("releases");

    try {
        if (!isDatabaseReady()) {
            markJobOffline("releases", "Database is offline.");
            return;
        }

        const watches = await ReleaseFeed.find({});
        let hadErrors = false;
        let lastError: string | null = null;

        for (const watch of watches) {
            try {
                const hydratedWatch = await hydrateWatchRecord(watch);
                if (!hydratedWatch) {
                    throw new Error(`Invalid GitHub watcher configuration for ${watch.url || watch.repoUrl || "unknown repository"}.`);
                }

                const guild = client.guilds.cache.get(hydratedWatch.guildId);
                if (!guild) continue;

                const guildConfig = await getGuildConfig(hydratedWatch.guildId);
                const targetChannelId = hydratedWatch.targetChannelId || guildConfig?.channelIds?.toolReleasesId;
                if (!targetChannelId) continue;

                const repository = await fetchRepository(hydratedWatch.repoFullName);
                if (!repository) {
                    throw new Error(`Repository ${hydratedWatch.repoFullName} could not be loaded from GitHub.`);
                }

                hydratedWatch.defaultBranch = hydratedWatch.defaultBranch || repository.default_branch;
                let hasChanges = false;

                if (hydratedWatch.watchReleases) {
                    const latestRelease = await fetchLatestRelease(repository.full_name);
                    if (latestRelease) {
                        const releaseId = String(latestRelease.id);
                        const hasExistingRelease = Boolean(hydratedWatch.lastReleaseId);
                        if (hydratedWatch.lastReleaseId !== releaseId) {
                            if (hasExistingRelease) {
                                const payload = buildReleaseEmbed(repository, latestRelease);
                                await sendWatchPayload(guild, targetChannelId, payload);
                            }

                            hydratedWatch.lastReleaseId = releaseId;
                            hydratedWatch.lastReleasePublishedAt = latestRelease.published_at
                                ? new Date(latestRelease.published_at)
                                : new Date();
                            hasChanges = true;
                        }
                    }
                }

                if (hydratedWatch.watchCommits) {
                    const latestCommit = await fetchLatestCommit(repository.full_name, hydratedWatch.defaultBranch);
                    if (latestCommit) {
                        const hasExistingCommit = Boolean(hydratedWatch.lastCommitSha);
                        if (hydratedWatch.lastCommitSha !== latestCommit.sha) {
                            const previousSha = hydratedWatch.lastCommitSha || null;

                            if (hasExistingCommit) {
                                const payload = buildCommitEmbed(
                                    repository,
                                    latestCommit,
                                    hydratedWatch.defaultBranch,
                                    previousSha
                                );
                                await sendWatchPayload(guild, targetChannelId, payload);
                            }

                            hydratedWatch.lastCommitSha = latestCommit.sha;
                            hydratedWatch.lastCommitPublishedAt = new Date(latestCommit.commit.author.date);
                            hasChanges = true;
                        }
                    }
                }

                if (hasChanges) {
                    await hydratedWatch.save();
                }
            } catch (error) {
                hadErrors = true;
                lastError = error instanceof Error ? error.message : String(error);
                console.error(`GitHub watcher poll error for ${watch.repoFullName || watch.url || "unknown"}:`, error);
            }
        }

        markJobFinished("releases", hadErrors, lastError);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        markJobOffline("releases", message);
        throw error;
    }
}

export function pollGitHub(client: Client) {
    if (activeReleasePoll) {
        return activeReleasePoll;
    }

    activeReleasePoll = runGitHubPoll(client).finally(() => {
        activeReleasePoll = null;
    });

    return activeReleasePoll;
}

export function startGitHubPoller(client: Client) {
    if (releasesPollerStarted) return;
    releasesPollerStarted = true;

    void pollGitHub(client).catch((error) => {
        console.error("Initial GitHub watcher poll failed:", error);
    });

    setInterval(() => {
        void pollGitHub(client).catch((error) => {
            console.error("GitHub watcher poll execution failed:", error);
        });
    }, 5 * 60 * 1000);

    console.log("Started GitHub watcher poller");
}
