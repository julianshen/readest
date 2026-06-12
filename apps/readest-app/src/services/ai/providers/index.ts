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
