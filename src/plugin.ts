/**
 * Quick Clips - Stream Deck Plugin Entry Point
 * 
 * @fileoverview Main entry point for the Quick Clips Stream Deck plugin.
 * Initializes the plugin, configures logging, registers actions, and establishes
 * connection with the Stream Deck application.
 * 
 * @module plugin
 * @author Glen Morgan
 * @version 1.0.0
 * @platform macOS
 */

import streamDeck from "@elgato/streamdeck";

import { ClipboardSlot } from "./actions/clipboard-slot";

/**
 * Configure logging level for the plugin.
 * 
 * Log levels available:
 * - "trace": Verbose debugging information (development only)
 * - "debug": Detailed diagnostic information
 * - "info": General informational messages (production default)
 * - "warn": Warning messages for potentially problematic situations
 * - "error": Error messages for serious problems
 * 
 * @see {@link https://docs.elgato.com/sdk/plugins/logging Stream Deck Logging Documentation}
 */
streamDeck.logger.setLevel("info");

/**
 * Register all plugin actions with the Stream Deck.
 * 
 * Each action must be registered before the plugin connects to Stream Deck.
 * The ClipboardSlot action provides clipboard capture, storage, and paste functionality.
 */
streamDeck.actions.registerAction(new ClipboardSlot());

/**
 * Establish connection with the Stream Deck application.
 * 
 * This initiates the WebSocket connection between the plugin and Stream Deck,
 * enabling bidirectional communication for events and commands. Must be called
 * after all actions are registered.
 * 
 * @see {@link https://docs.elgato.com/sdk/plugins/registration Stream Deck Connection Documentation}
 */
streamDeck.connect();

