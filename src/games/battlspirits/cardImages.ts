import type { CardDef } from './types.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Get the absolute path to a card image file.
 * Returns the image path if it exists, otherwise returns undefined.
 */
export function getCardImagePath(card: CardDef): string | undefined {
  if (!card.imagePath) return undefined;

  // Check relative to project root
  const projectRoot = process.cwd();
  const absolutePath = join(projectRoot, card.imagePath);

  if (existsSync(absolutePath)) {
    return absolutePath;
  }

  return undefined;
}

/**
 * Get all card image paths that exist in the assets directory.
 * Useful for checking which cards have images available.
 */
export function getAvailableCardImages(): Record<string, string> {
  const projectRoot = process.cwd();
  const cardsDir = join(projectRoot, 'assets', 'cards');
  const images: Record<string, string> = {};

  try {
    const fs = require('fs');
    const files = fs.readdirSync(cardsDir);

    for (const file of files) {
      if (file.match(/\.(jpg|jpeg|png)$/i)) {
        const cardId = file.replace(/\.(jpg|jpeg|png)$/i, '');
        const imagePath = join(cardsDir, file);
        images[cardId] = imagePath;
      }
    }
  } catch (error) {
    // Directory doesn't exist yet or can't be read
  }

  return images;
}

/**
 * Load a card image as base64 for embedding in web or markdown.
 * Returns the base64 string if file exists, otherwise undefined.
 */
export function getCardImageAsBase64(card: CardDef): string | undefined {
  const imagePath = getCardImagePath(card);
  if (!imagePath) return undefined;

  try {
    const buffer = readFileSync(imagePath);
    return buffer.toString('base64');
  } catch (error) {
    return undefined;
  }
}

/**
 * Get MIME type from file extension.
 */
export function getImageMimeType(imagePath: string): string {
  if (imagePath.endsWith('.png')) return 'image/png';
  if (imagePath.endsWith('.jpg') || imagePath.endsWith('.jpeg')) return 'image/jpeg';
  return 'image/jpeg'; // default
}

/**
 * Create a data URL for embedding in HTML/Markdown.
 */
export function getCardImageDataUrl(card: CardDef): string | undefined {
  const base64 = getCardImageAsBase64(card);
  if (!base64) return undefined;

  const mimeType = card.imagePath ? getImageMimeType(card.imagePath) : 'image/jpeg';
  return `data:${mimeType};base64,${base64}`;
}
