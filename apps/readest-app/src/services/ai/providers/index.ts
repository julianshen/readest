import { OllamaProvider } from './OllamaProvider';
import { AIGatewayProvider } from './AIGatewayProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import { OpenAIProvider } from './OpenAIProvider';
import type { AIProvider, AISettings } from '../types';

export { OllamaProvider, AIGatewayProvider, OpenRouterProvider, OpenAIProvider };

export function getAIProvider(settings: AISettings): AIProvider {
  switch (settings.provider) {
    case 'ollama':
      return new OllamaProvider(settings);
    case 'ai-gateway':
      if (!settings.aiGatewayApiKey) {
        throw new Error('API key required for AI Gateway');
      }
      return new AIGatewayProvider(settings);
    case 'openrouter':
      if (!settings.openrouterApiKey) {
        throw new Error('API key required for OpenRouter');
      }
      return new OpenRouterProvider(settings);
    case 'openai':
      if (!settings.openaiApiKey) {
        throw new Error('API key required for OpenAI');
      }
      return new OpenAIProvider(settings);
    default:
      throw new Error(`Unknown provider: ${settings.provider}`);
  }
}

// True when the assistant is enabled AND the selected provider has the
// credentials it needs (getAIProvider throws otherwise). Used to gate UI that
// triggers AI calls (e.g. the selection-toolbar AI button).
export function isAIAssistantConfigured(settings: AISettings | undefined): boolean {
  if (!settings?.enabled) return false;
  try {
    getAIProvider(settings);
    return true;
  } catch {
    return false;
  }
}

/**
 * Single source of truth for embedding config (base URL + model ID) shared
 * between JS providers and the Rust/Tauri indexing backend.
 *
 * Keys and defaults here MUST mirror what each provider's constructor uses
 * so the Rust embed_texts path sends the same model/baseUrl as the JS path.
 */
export function getEmbeddingModelId(settings: AISettings): string {
  switch (settings.provider) {
    case 'openrouter':
      return settings.openrouterEmbeddingModel || 'openai/text-embedding-3-small';
    case 'openai':
      return settings.openaiEmbeddingModel || 'text-embedding-3-small';
    case 'ai-gateway':
      return settings.aiGatewayEmbeddingModel || 'openai/text-embedding-3-small';
    case 'ollama':
      return settings.ollamaEmbeddingModel || 'nomic-embed-text';
    default:
      return 'text-embedding-3-small';
  }
}

export function getEmbeddingBaseUrl(settings: AISettings): string {
  switch (settings.provider) {
    case 'openrouter':
      return settings.openrouterBaseUrl || 'https://openrouter.ai/api/v1';
    case 'openai':
      return settings.openaiBaseUrl || 'https://api.openai.com/v1';
    case 'ollama':
      return settings.ollamaBaseUrl || 'http://127.0.0.1:11434';
    case 'ai-gateway':
      return settings.openaiBaseUrl || 'https://api.openai.com/v1';
    default:
      return settings.openaiBaseUrl || 'https://api.openai.com/v1';
  }
}

export function getEmbeddingApiKey(settings: AISettings): string {
  switch (settings.provider) {
    case 'openrouter':
      return settings.openrouterApiKey || '';
    case 'openai':
      return settings.openaiApiKey || '';
    case 'ollama':
      return '';
    case 'ai-gateway':
      return settings.aiGatewayApiKey || '';
    default:
      return '';
  }
}

/**
 * Providers the Rust/Tauri embedder can dispatch to directly via HTTP.
 * - ai-gateway uses the Vercel AI SDK (not a plain OpenAI-compatible endpoint).
 * - ollama's native embed endpoint is /api/embed, not /embeddings, so keep it
 *   on the legacy JS provider adapter until a compatible endpoint is added.
 */
export function isRustEmbeddingSupported(settings: AISettings): boolean {
  return settings.provider === 'openai' || settings.provider === 'openrouter';
}
