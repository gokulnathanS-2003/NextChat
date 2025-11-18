"use client";

import {
  ApiPath,
  BIOMED_RAG_BASE_URL,
  REQUEST_TIMEOUT_MS,
} from "@/app/constant";
import {
  useAccessStore,
  useAppConfig,
  useChatStore,
} from "@/app/store";
import {
  getMessageTextContent,
} from "@/app/utils";

import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  LLMUsage,
  SpeechOptions,
} from "../api";
import Locale from "../../locales";
import { getClientConfig } from "@/app/config/client";
import { fetch } from "@/app/utils/stream";

// BiomedRAG API interfaces
export interface BiomedRagQueryRequest {
  query: string;
  email: string;
  interactive?: boolean;
  user_feedback?: any;
}

export interface BiomedRagQueryResponse {
  generated: string;
  citations: any;
  past_searches: any[];
  sources: string[];
}

export class BiomedRagApi implements LLMApi {
  private disableListModels = true;

  path(path: string): string {
    const accessStore = useAccessStore.getState();
    const clientConfig = getClientConfig();

    let baseUrl = "";

    if (accessStore.useCustomConfig && accessStore.biomedragUrl) {
      baseUrl = accessStore.biomedragUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      baseUrl = isApp ? BIOMED_RAG_BASE_URL : ApiPath.BiomedRAG;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }

    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.BiomedRAG)) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[BiomedRAG Proxy Endpoint] ", baseUrl, path);

    return [baseUrl, path].join("/");
  }

  async extractMessage(res: any) {
    if (res.error) {
      return "```\n" + JSON.stringify(res, null, 4) + "\n```";
    }

    // Format the biomedical response with citations and sources
    const response: BiomedRagQueryResponse = res;
    let formattedResponse = response.generated || "";

    // Add citations if available
    if (response.citations && Object.keys(response.citations).length > 0) {
      formattedResponse += "\n\n**Citations:**\n";
      Object.entries(response.citations).forEach(([key, citation]: [string, any], index) => {
        formattedResponse += `${index + 1}. ${JSON.stringify(citation)}\n`;
      });
    }

    // Add sources if available
    if (response.sources && response.sources.length > 0) {
      formattedResponse += "\n\n**Data Sources:**\n";
      response.sources.forEach((source, index) => {
        formattedResponse += `${index + 1}. ${source}\n`;
      });
    }

    return formattedResponse;
  }

  async speech(options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error("Speech synthesis is not supported by BiomedRAG");
  }

  async chat(options: ChatOptions) {
    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
        providerName: options.config.providerName,
      },
    };

    // Get user email from access store for BiomedRAG tracking
    const accessStore = useAccessStore.getState();
    const userEmail = accessStore.biomedragEmail || "user@example.com";

    // Extract the user's query from messages
    const userMessage = options.messages.find(msg => msg.role === "user");
    if (!userMessage) {
      throw new Error("No user message found in BiomedRAG request");
    }

    const query = getMessageTextContent(userMessage);

    // Build BiomedRAG request payload
    const requestPayload: BiomedRagQueryRequest = {
      query,
      email: userEmail,
      interactive: false, // Disable interactive mode for chat
      user_feedback: null,
    };

    console.log("[BiomedRAG Request] payload: ", requestPayload);

    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const chatPath = this.path("/query");
      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...getHeaders(),
        },
      };

      // Make a fetch request with extended timeout for BiomedRAG processing
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS * 3, // Extended timeout for BiomedRAG (3x normal timeout)
      );

      const res = await fetch(chatPath, chatPayload);
      clearTimeout(requestTimeoutId);

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`BiomedRAG API error: ${res.status} ${res.statusText} - ${errorText}`);
      }

      const resJson = await res.json();
      const message = await this.extractMessage(resJson);
      options.onFinish(message, res);
    } catch (e) {
      console.log("[BiomedRAG Request] failed to make a request", e);
      options.onError?.(e as Error);
    }
  }

  async usage(): Promise<LLMUsage> {
    // BiomedRAG doesn't provide usage statistics
    return {
      used: 0,
      total: 0,
    };
  }

  async models(): Promise<LLMModel[]> {
    if (this.disableListModels) {
      return [{
        name: "biomedrag-query",
        available: true,
        sorted: 1000,
        provider: {
          id: "biomedrag",
          providerName: "BiomedRAG",
          providerType: "biomedrag",
          sorted: 16,
        },
      }];
    }

    return [];
  }
}