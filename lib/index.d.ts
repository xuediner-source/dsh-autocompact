import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-autocompact";
/** Only llm is mandatory; settings/commands are resolved defensively. */
export declare const inject: string[];
export declare function apply(ctx: Context): void;
