'use client';

import { CopilotAIAssistant } from './CopilotAIAssistant';

/**
 * AI Assistant panel for the notebook.
 *
 * Routes to the CopilotKit-powered assistant or the Reedy agent bridge
 * based on settings. The actual implementation lives in CopilotAIAssistant.
 */
const AIAssistant = ({ bookKey }: { bookKey: string }) => {
  return <CopilotAIAssistant bookKey={bookKey} />;
};

export default AIAssistant;
