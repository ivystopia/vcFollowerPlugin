/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The above header is a linting requirement of the Vencord project workspace.
// This plugin is unaffiliated with the Vencord project.

// External Imports
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Notifications } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import { getCurrentChannel, openUserProfile } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginDef } from "@utils/types";
import { findByProps } from "@webpack";
import { ChannelStore, Menu, MessageStore, RestAPI, Toasts, UserStore } from "@webpack/common";
import { Message } from "discord-types/general";

import {
    MessageCreatePayload,
    MessageDeletePayload,
    MessageUpdatePayload,
    ThreadCreatePayload,
    TypingStartPayload,
    UserUpdatePayload,
} from "./types";

/**
 * Dynamically imports the LoggedMessageManager from possible locations.
 * Ensures compatibility with different Vencord environments.
 * @returns The loggedMessages module or null if failed to load.
 */
async function importLoggedMessages() {
    let module;
    try {
        // Attempt to import from EquiCord plugins
        // @ts-ignore
        module = await import("equicordplugins/messageLoggerEnhanced/LoggedMessageManager");
    } catch {
        try {
            // Fallback to user plugins
            // @ts-ignore
            module = await import("userplugins/vc-message-logger-enhanced/LoggedMessageManager");
        } catch (error) {
            console.error(`Failed to load MessageLoggerEnhanced: ${error}`);
        }
    }
    return module ? module.loggedMessages : null;
}

// Base64-encoded transparent icon
const TRANSPARENT_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2NkYGD4DwABBAEAQ6yD0gAAAABJRU5ErkJggg==";

// Logger instance for the plugin
const logger = new Logger("Follower");

// Plugin settings that appear in the Vencord GUI
var settings = definePluginSettings({
    whitelistedIds: {
        default: "",
        type: OptionType.STRING,
        description: "Users to follow (comma-separated list of IDs)",
    },
    trackProfileChanges: {
        default: false,
        type: OptionType.BOOLEAN,
        description: "Show notification when a user profile changes [BROKEN]",
    },
    trackStartedTyping: {
        default: true,
        type: OptionType.BOOLEAN,
        description: "Show notification when a user starts typing",
    },
    trackSentMessage: {
        default: true,
        type: OptionType.BOOLEAN,
        description: "Show notification when a user sends a message",
    },
    showMessageBody: {
        default: true,
        type: OptionType.BOOLEAN,
        description: "Include message contents in notification",
    },
    charLimit: {
        default: 118,
        type: OptionType.NUMBER,
        description: "Character limit for notifications. Set to 0 for no limit. Default=118",
    },
});

// Stores previous user profiles for detecting changes
// TODO: Create our own representation of a User
const oldUsers: Record<string, UserUpdatePayload> = {};

// Stores logged messages
let loggedMessages: Record<string, Message> = {};

/**
 * Adds a user ID to the list of followed users.
 * @param id - The user ID to add.
 */
function addToWhitelist(id: string): void {
    const items = settings.store.whitelistedIds
        ? settings.store.whitelistedIds.split(",").map(item => item.trim()).filter(item => item !== "")
        : [];
    if (!items.includes(id)) {
        items.push(id);
        settings.store.whitelistedIds = items.join(",");
        logger.info(`Added ID ${id} to whitelist.`);
    } else {
        logger.warn(`ID ${id} is already in the whitelist.`);
    }
}

/**
 * Removes a user ID to the list of followed users.
 * @param id - The user ID to remove.
 */
function removeFromWhitelist(id: string): void {
    const items = settings.store.whitelistedIds
        ? settings.store.whitelistedIds.split(",").map(item => item.trim()).filter(item => item !== "")
        : [];
    const index = items.indexOf(id);
    if (index !== -1) {
        items.splice(index, 1);
        settings.store.whitelistedIds = items.join(",");
        logger.info(`Removed ID ${id} from whitelist.`);
    } else {
        logger.warn(`ID ${id} not found in the whitelist.`);
    }
}

/**
 * Checks if a user ID is in the list of followed users.
 * @param id - The user ID to check.
 * @returns True if the ID is whitelisted, otherwise false.
 */
function isInWhitelist(id: string): boolean {
    const items = settings.store.whitelistedIds
        ? settings.store.whitelistedIds.split(",").map(item => item.trim()).filter(item => item !== "")
        : [];
    return items.includes(id);
}

/**
 * Converts snake_case keys in an object to camelCase.
 * @param obj - The object to convert.
 * @returns A new object with camelCase keys.
 */
function convertSnakeCaseToCamelCase(obj: any): any {
    if (!Array.isArray(obj) && (typeof obj !== "object" || obj === null)) return obj;

    if (Array.isArray(obj)) return obj.map(convertSnakeCaseToCamelCase);

    return Object.keys(obj).reduce((newObj, key) => {
        const camelCaseKey = key.replace(/_([a-z])/gi, (_, char) => char.toUpperCase());
        const value = convertSnakeCaseToCamelCase(obj[key]);
        return { ...newObj, [camelCaseKey]: value };
    }, {} as any);
}

/**
 * Switches the view to a specific message.
 * @param guildId - The guild ID.
 * @param channelId - The channel ID (optional).
 * @param messageId - The message ID (optional).
 */
const switchToMsg = (guildId: string, channelId?: string, messageId?: string) => {
    const { transitionToGuildSync } = findByProps("transitionToGuildSync");
    const { selectChannel } = findByProps("selectChannel");

    if (guildId) transitionToGuildSync(guildId);
    if (channelId)
        selectChannel({
            guildId: guildId || "@me",
            channelId,
            messageId,
        });
};

/**
 * Creates a notification.
 * @param title - The notification title.
 * @param body - The notification body.
 * @param onClick - Callback when the notification is clicked.
 * @param icon - The notification icon (optional).
 */
const createNotification = (
    title: string,
    body: string,
    onClick: () => void,
    icon?: string // Made icon optional
) => {
    Notifications.showNotification({
        title,
        body,
        onClick,
        icon: icon || TRANSPARENT_ICON,
    });
};

/**
 * Determines whether to show a notification based on whitelist and current channel.
 * @param userId - The user ID.
 * @param channelId - The channel ID.
 * @returns True if a notification should be shown, otherwise false.
 */
const shouldNotify = (userId: string, channelId: string | undefined): boolean => {
    return isInWhitelist(userId) && getCurrentChannel()?.id !== channelId;
};

/**
 * Generates the message body for notifications based on settings.
 * @param store - The settings store.
 * @param payload - The message payload.
 * @returns The formatted message body.
 */
function getMessageBody(store: typeof settings.store, payload: MessageCreatePayload | MessageUpdatePayload): string {
    if (!store.showMessageBody) return "Click to jump to the message";

    const { charLimit } = store;
    const { content, attachments } = payload.message;
    const baseContent = content || attachments?.[0]?.filename || "Click to jump to the message";

    return charLimit > 0 && baseContent.length > charLimit ? `${baseContent.substring(0, charLimit)}...` : baseContent;
}

/* ============================ */
/*      Context Menu Patch      */
/* ============================ */

/**
 * Define the patch for the context menu, which contains the option to follow/unfollow a user.
 */
const contextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props || props.user.id === UserStore.getCurrentUser().id) return;

    if (!children.some(child => child?.props?.id === "follower-v1")) {
        children.push(
            <Menu.MenuSeparator />,
            <Menu.MenuItem
                id="follower-v1"
                label={isInWhitelist(props.user.id) ? "Stop Following User" : "Follow User"}
                action={() =>
                    isInWhitelist(props.user.id) ? _plugin.unfollowUser(props.user.id) : _plugin.followUser(props.user.id)
                }
            />
        );
    }
};

/* ============================ */
/*      Plugin Definition       */
/* ============================ */

const _plugin: PluginDef & Record<string, any> = {
    name: "Follower",
    description: "Add additional notification features for your friends' activity on Discord",
    authors: [
        {
            id: 835582393230164018n,
            name: "h.helix", // Repository maintainer
        },
        {
            id: 253302259696271360n,
            name: "zastix", // Maintainer of initial plugin
        },
    ],
    dependencies: ["MessageLoggerEnhanced"],
    settings,
    contextMenus: {
        "user-context": contextMenuPatch,
    },
    flux: {
        MESSAGE_CREATE: (payload: MessageCreatePayload) => {
            const { message, guildId, channelId } = payload;
            if (!message?.author?.id || !channelId || !settings.store.trackSentMessage) return;

            const authorId = message.author.id;
            if (!shouldNotify(authorId, channelId)) return;
            const author = UserStore.getUser(authorId);

            if (message.type === 7) {
                // Guild Join Type
                createNotification(
                    `${author.username} Joined a server`,
                    "Click to jump to the message.",
                    () => switchToMsg(guildId, channelId, message.id),
                    author.getAvatarURL(undefined, undefined, false)
                );
                return;
            }

            createNotification(
                `${author.username} Sent a message`,
                getMessageBody(settings.store, payload),
                () => switchToMsg(guildId, channelId, message.id),
                author.getAvatarURL(undefined, undefined, false)
            );
        },
        MESSAGE_UPDATE: (payload: MessageUpdatePayload) => {
            const { message, guildId, channelId } = payload;
            if (!message?.author?.id || !channelId) return;

            const authorId = message.author.id;
            if (!shouldNotify(authorId, channelId)) return;
            const author = UserStore.getUser(authorId);

            createNotification(
                `${author.username} Edited a message`,
                getMessageBody(settings.store, payload),
                () => switchToMsg(guildId, channelId, message.id),
                author.getAvatarURL(undefined, undefined, false)
            );
        },
        MESSAGE_DELETE: async (payload: MessageDeletePayload) => {
            const { id, channelId, guildId } = payload;
            if (!id || !channelId || !guildId) return;

            let message = MessageStore.getMessage(channelId, id) || loggedMessages[id];
            if (!message) {
                loggedMessages = (await importLoggedMessages()) || {};
                message = MessageStore.getMessage(channelId, id) || loggedMessages[id];
            }
            if (!message) {
                logger.error(
                    'Received a MESSAGE_DELETE event but the message was not found in the MessageStore. Consider enabling "Cache Messages From Servers" setting in MessageLoggerEnhanced.'
                );
                return;
            }

            const authorId = message.author?.id;
            if (!shouldNotify(authorId, message.channel_id)) return;
            const author = UserStore.getUser(authorId);

            createNotification(
                `${author.username} Deleted a message!`,
                `"${message.content.length > 100 ? message.content.substring(0, 100) + "..." : message.content}"`,
                () => {
                    findByProps("selectChannel").selectChannel({
                        guildId,
                        channelId: message.channel_id,
                        messageId: message.id,
                    });
                },
                author.getAvatarURL(undefined, undefined, false)
            );
        },
        TYPING_START: (payload: TypingStartPayload) => {
            const { channelId, userId } = payload;
            if (!channelId || !userId || !settings.store.trackStartedTyping) return;

            if (!shouldNotify(userId, channelId)) return;
            const author = UserStore.getUser(userId);

            createNotification(
                `${author.username} Started typing...`,
                "Click to jump to the channel.",
                () => switchToMsg(ChannelStore.getChannel(channelId).guild_id, channelId),
                author.getAvatarURL(undefined, undefined, false)
            );
        },
        USER_PROFILE_FETCH_SUCCESS: async (payload: UserUpdatePayload) => {
            const { user } = payload;
            if (!user?.id || !isInWhitelist(user.id) || !settings.store.trackProfileChanges) return;

            const normalizedPayload = convertSnakeCaseToCamelCase(payload);
            const oldUser = oldUsers[user.id] ? convertSnakeCaseToCamelCase(oldUsers[user.id]) : null;

            if (!oldUser) {
                oldUsers[user.id] = normalizedPayload;
                return;
            }

            const changedKeys = Object.keys(user).filter(
                key =>
                    user[key] !== oldUser.user[key] &&
                    [
                        "username",
                        "globalName",
                        "avatar",
                        "discriminator",
                        "clan",
                        "flags",
                        "banner",
                        "banner_color",
                        "accent_color",
                        "bio",
                    ].includes(key)
            );

            if (changedKeys.length === 0) return;

            const notificationTitle = user.username;
            const notificationBody = `Updated properties: ${changedKeys.join(", ")}.`;
            const avatarURL = UserStore.getUser(user.id).getAvatarURL(undefined, undefined, false);

            createNotification(
                `${notificationTitle} updated their profile!`,
                notificationBody,
                () => openUserProfile(user.id),
                avatarURL
            );

            oldUsers[user.id] = normalizedPayload;
        },
        THREAD_CREATE: (payload: ThreadCreatePayload) => {
            const { channel, isNewlyCreated } = payload;
            if (!channel?.id || !channel.ownerId || !isInWhitelist(channel.ownerId)) return;

            if (isNewlyCreated) {
                const owner = UserStore.getUser(channel.ownerId);
                createNotification(
                    `New thread created by ${owner.username}`,
                    "Click to view the thread.",
                    () => switchToMsg(channel.guild_id, channel.parent_id),
                    owner.getAvatarURL(undefined, undefined, false)
                );
            }
        },
    },
    async start() {
        if (!Vencord.Plugins.plugins.MessageLoggerEnhanced) {
            createNotification(
                "Follower plugin requires MessageLoggerEnhanced to be enabled",
                "Click to download it.",
                () => open("https://github.com/Syncxv/vc-message-logger-enhanced/"),
                TRANSPARENT_ICON
            );
            return;
        }

        // Maintain a list of users the plugin will apply to
        const whitelistIds = settings.store.whitelistedIds
            .split(",")
            .map(id => id.trim())
            .filter(id => id !== "");
        for (const id of whitelistIds) {
            try {
                const { body } = await RestAPI.get({
                    url: `/users/${id}/profile`,
                    query: {
                        with_mutual_guilds: true,
                        with_mutual_friends_count: true,
                    },
                });
                oldUsers[id] = convertSnakeCaseToCamelCase(body);
                logger.info(`Cached user ${id} with name ${oldUsers[id].user.username || oldUsers[id].user.username} for further usage.`);
            } catch (error) {
                logger.error(`Failed to cache user ${id}: ${error}`);
            }
        }

        loggedMessages = (await importLoggedMessages()) || {};
    },
    stop() {
        // Optional: Clean up resources or listeners
    },
    async followUser(id: string) {
        const user = UserStore.getUser(id);
        Toasts.show({
            type: Toasts.Type.SUCCESS,
            message: `Following ${user.usernameNormalized || user.username}`,
            id: Toasts.genId(),
        });
        addToWhitelist(id);

        try {
            const { body } = await RestAPI.get({
                url: `/users/${id}/profile`,
                query: {
                    with_mutual_guilds: true,
                    with_mutual_friends_count: true,
                },
            });
            oldUsers[id] = convertSnakeCaseToCamelCase(body);
            logger.info(`Cached user ${id} with name ${oldUsers[id].user.globalName || oldUsers[id].user.username} for further usage.`);
        } catch (error) {
            logger.error(`Failed to cache user ${id} during follow: ${error}`);
        }
    },
    unfollowUser(id: string) {
        const user = UserStore.getUser(id);
        Toasts.show({
            type: Toasts.Type.SUCCESS,
            message: `Stopped following ${user.usernameNormalized || user.username}`,
            id: Toasts.genId(),
        });
        removeFromWhitelist(id);
        delete oldUsers[id];
    },
};

// Make the plugin available to Vencord
export default definePlugin(_plugin);
export { settings };
