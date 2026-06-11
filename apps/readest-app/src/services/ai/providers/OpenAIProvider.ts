import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel, EmbeddingModel } from 'ai';
import type { AIProvider, AISettings, AIProviderName } from '../types';
import { aiLogger } from '../logger';
import { DEFAULT_AI_SETTINGS } from '../constants';
import { AI_TIMEOUTS } from '../utils/retry';
import { getAIFetch } from '../utils/httpFetch';

// Single source of truth is DEFAULT_AI_SETTINGS; aliased here for readability.
const DEFAULT_BASE_URL = DEFAULT_AI_SETTINGS.openaiBaseUrl!;
const DEFAULT_MODEL = DEFAULT_AI_SETTINGS.openaiModel!;
const DEFAULT_EMBEDDING_MODEL = DEFAULT_AI_SETTINGS.openaiEmbeddingModel!;

/**
 * OpenAI's official API. Functionally a sibling of `OpenRouterProvider`
 * (both speak the OpenAI REST schema via `@ai-sdk/openai-compatible`), but
 * with its own credential set so translation can rely on OpenAI while the
 * assistant uses a different provider. The base URL is overridable for
 * Azure OpenAI deployments and proxies.
 *
 * Transport goes through {@link getAIFetch}: Tauri's Rust HTTP plugin in
 * the app (no CORS preflight, no Android cleartext block), window.fetch on
 * the web build.
 */
export class OpenAIProvider implements AIProvider {
  id: AIProviderName = 'openai';
  name = 'OpenAI (ChatGPT)';
  requiresAuth = true;

  readonly baseUrl: string;

  private settings: AISettings;
  private client: ReturnType<typeof createOpenAICompatible>;
  private apiKey: string;
  private httpFetch: typeof fetch;

  constructor(settings: AISettings) {
    this.settings = settings;
    if (!settings.openaiApiKey) {
      throw new Error('OpenAI API key required');
    }
    this.apiKey = settings.openaiApiKey;
    this.baseUrl = (settings.openaiBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.httpFetch = getAIFetch();
    this.client = createOpenAICompatible({
      name: 'openai',
      baseURL: this.baseUrl,
      apiKey: this.apiKey,
      fetch: this.httpFetch,
    });
    aiLogger.provider.init('openai', settings.openaiModel || DEFAULT_MODEL);
  }

  getModel(): LanguageModel {
    const modelId = this.settings.openaiModel || DEFAULT_MODEL;
    return this.client.chatModel(modelId);
  }

  getEmbeddingModel(): EmbeddingModel {
    const modelId = this.settings.openaiEmbeddingModel || DEFAULT_EMBEDDING_MODEL;
    return this.client.textEmbeddingModel(modelId);
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const modelId = this.settings.openaiModel || DEFAULT_MODEL;
      aiLogger.provider.init('openai', `healthCheck starting with model: ${modelId}`);
      const response = await this.httpFetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(AI_TIMEOUTS.HEALTH_CHECK),
      });
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }
      aiLogger.provider.init('openai', 'healthCheck success');
      return true;
    } catch (e) {
      aiLogger.provider.error('openai', `healthCheck failed: ${(e as Error).message}`);
      return false;
    }
  }
}
