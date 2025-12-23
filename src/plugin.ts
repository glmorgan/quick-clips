import streamDeck from "@elgato/streamdeck";

import { ClipboardSlot } from "./actions/clipboard-slot";

// We can enable "trace" logging so that all messages between the Stream Deck, and the plugin are recorded. When storing sensitive information
streamDeck.logger.setLevel("trace");

// Register the clipboard slot action.
streamDeck.actions.registerAction(new ClipboardSlot());

// Finally, connect to the Stream Deck.
streamDeck.connect();
