import { Injectable } from '@nestjs/common';
import { AiPrompt, PrismaClient } from '@prisma/client';
import Mustache from 'mustache';
import { Tiktoken } from 'tiktoken';

import {
  getTokenEncoder,
  PromptMessage,
  PromptMessageSchema,
  PromptParams,
} from './types';

// disable escaping
Mustache.escape = (text: string) => text;

function extractMustacheParams(template: string) {
  const regex = /\{\{\s*([^{}]+)\s*\}\}/g;
  const params = [];
  let match;

  while ((match = regex.exec(template)) !== null) {
    params.push(match[1]);
  }

  return Array.from(new Set(params));
}

export class ChatPrompt {
  public readonly encoder?: Tiktoken;
  private readonly promptTokenSize: number;
  private readonly templateParamKeys: string[] = [];
  private readonly templateParams: PromptParams = {};

  static createFromPrompt(
    options: Omit<AiPrompt, 'id' | 'createdAt'> & {
      messages: PromptMessage[];
    }
  ) {
    return new ChatPrompt(
      options.name,
      options.action || undefined,
      options.model || undefined,
      options.messages
    );
  }

  constructor(
    public readonly name: string,
    public readonly action: string | undefined,
    public readonly model: string | undefined,
    private readonly messages: PromptMessage[]
  ) {
    this.encoder = getTokenEncoder(model);
    this.promptTokenSize =
      this.encoder?.encode_ordinary(messages.map(m => m.content).join('') || '')
        .length || 0;
    this.templateParamKeys = extractMustacheParams(
      messages.map(m => m.content).join('')
    );
    this.templateParams = messages.reduce(
      (acc, m) => Object.assign(acc, m.params),
      {} as PromptParams
    );
  }

  /**
   * get prompt token size
   */
  get tokens() {
    return this.promptTokenSize;
  }

  /**
   * get prompt param keys in template
   */
  get paramKeys() {
    return this.templateParamKeys.slice();
  }

  /**
   * get prompt params
   */
  get params() {
    return { ...this.templateParams };
  }

  encode(message: string) {
    return this.encoder?.encode_ordinary(message).length || 0;
  }

  private checkParams(params: PromptParams) {
    const selfParams = this.templateParams;
    for (const key of Object.keys(selfParams)) {
      const options = selfParams[key];
      const income = params[key];
      if (
        typeof income !== 'string' ||
        (Array.isArray(options) && !options.includes(income))
      ) {
        throw new Error(`Invalid param: ${key}`);
      }
    }
  }

  /**
   * render prompt messages with params
   * @param params record of params, e.g. { name: 'Alice' }
   * @returns e.g. [{ role: 'system', content: 'Hello, {{name}}' }] => [{ role: 'system', content: 'Hello, Alice' }]
   */
  finish(params: PromptParams): PromptMessage[] {
    this.checkParams(params);
    return this.messages.map(({ content, params: _, ...rest }) => ({
      ...rest,
      params,
      content: Mustache.render(content, params),
    }));
  }

  free() {
    this.encoder?.free();
  }
}

@Injectable()
export class PromptService {
  private readonly cache = new Map<string, ChatPrompt>();

  constructor(private readonly db: PrismaClient) {}

  /**
   * list prompt names
   * @returns prompt names
   */
  async list() {
    return this.db.aiPrompt
      .findMany({ select: { name: true } })
      .then(prompts => Array.from(new Set(prompts.map(p => p.name))));
  }

  /**
   * get prompt messages by prompt name
   * @param name prompt name
   * @returns prompt messages
   */
  async get(name: string): Promise<ChatPrompt | null> {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const prompt = await this.db.aiPrompt.findUnique({
      where: {
        name,
      },
      select: {
        name: true,
        action: true,
        model: true,
        messages: {
          select: {
            role: true,
            content: true,
            params: true,
          },
          orderBy: {
            idx: 'asc',
          },
        },
      },
    });

    const messages = PromptMessageSchema.array().safeParse(prompt?.messages);
    if (prompt && messages.success) {
      const chatPrompt = ChatPrompt.createFromPrompt({
        ...prompt,
        messages: messages.data,
      });
      this.cache.set(name, chatPrompt);
      return chatPrompt;
    }
    return null;
  }

  async set(name: string, messages: PromptMessage[]) {
    return await this.db.aiPrompt
      .create({
        data: {
          name,
          messages: {
            create: messages.map((m, idx) => ({
              idx,
              ...m,
              attachments: m.attachments || undefined,
              params: m.params || undefined,
            })),
          },
        },
      })
      .then(ret => ret.id);
  }

  async update(name: string, messages: PromptMessage[]) {
    const { id } = await this.db.aiPrompt.update({
      where: { name },
      data: {
        messages: {
          // cleanup old messages
          deleteMany: {},
          create: messages.map((m, idx) => ({
            idx,
            ...m,
            attachments: m.attachments || undefined,
            params: m.params || undefined,
          })),
        },
      },
    });

    this.cache.delete(name);
    return id;
  }

  async delete(name: string) {
    const { id } = await this.db.aiPrompt.delete({ where: { name } });
    this.cache.delete(name);
    return id;
  }
}
