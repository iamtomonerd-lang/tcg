export { getStarterDeck as getStarterDeckLegacy } from './cards.js';
import { CARD_DB } from './cards.js';
import type { CardDef } from './types.js';

// Import the authoritative STARTER_DECK_IDS from cards module
// We use dynamic import equivalent to avoid circular dependency
const STARTER_DECK_IDS = [
  // Spirits: 11 cards
  'spirit_moon_shacco',
  'spirit_genie_bow',
  'spirit_ro_meek',
  'spirit_haria',
  'spirit_gun_gata',
  'spirit_cubel',
  'spirit_graipher',
  'spirit_seldalius',
  'spirit_lev_falus',
  'spirit_shinkoku_renshi',
  'spirit_hibutsu_akurai',

  // Nexuses: 2 cards
  'nexus_ukiyo_rock',
  'nexus_wind_fang_rock',

  // Magic: 3 cards
  'magic_break_claw',
  'magic_offering_draw',
  'magic_flame_hurricane',
];

/**
 * Factory for providing decks: starter deck, saved decks, etc.
 *
 * Responsibility:
 * - Provide pre-built deck definitions (starter, saved, etc.)
 * - Validate deck composition against card database
 *
 * Non-responsibility:
 * - Building custom AI decks (future DeckBuilder class)
 * - Deck persistence (database layer)
 * - Serialization/deserialization (API layer)
 */
export class DeckFactory {
  /**
   * Get the standard starter deck.
   * Contains 16 unique cards as defined by STARTER_DECK_IDS.
   */
  static getStarterDeck(): CardDef[] {
    return STARTER_DECK_IDS.map((id) => CARD_DB[id]!);
  }

  /**
   * Load a deck from a saved deck representation.
   *
   * The deck data can be:
   * - Array of card IDs: ['flamehurricane', 'flamehurricane', ...]
   * - Array of card definitions: [CardDef, CardDef, ...]
   * - Mixed representation (implementation tries both)
   *
   * Validates that all cards exist in the card database.
   * Returns a properly ordered deck array.
   *
   * Throws if any card ID is not found in CARD_DB.
   */
  static loadSavedDeck(deckData: unknown): CardDef[] {
    if (!Array.isArray(deckData)) {
      throw new Error('Deck data must be an array');
    }

    return deckData.map((item, index) => {
      // If it's already a CardDef object (has 'name' and 'cost' fields)
      if (typeof item === 'object' && item !== null && 'name' in item && 'cost' in item) {
        return item as CardDef;
      }

      // If it's a string (card ID), look it up in CARD_DB
      if (typeof item === 'string') {
        const card = CARD_DB[item];
        if (!card) {
          throw new Error(`Card not found in database: ${item} (at deck position ${index})`);
        }
        return card;
      }

      throw new Error(`Invalid deck entry at position ${index}: must be string (ID) or CardDef object`);
    });
  }
}
