import streamDeck from "@elgato/streamdeck";

import { ClipboardSlot } from "./actions/clipboard-slot";

// Set log level to "info" for production (use "trace" for debugging)
streamDeck.logger.setLevel("info");

// Register the clipboard slot action.
streamDeck.actions.registerAction(new ClipboardSlot());

// Finally, connect to the Stream Deck.
streamDeck.connect();
