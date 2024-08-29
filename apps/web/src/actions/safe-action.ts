import * as Sentry from "@sentry/nextjs";
import { ratelimit } from "@v1/kv";
import { logger } from "@v1/logger";
import { getUser } from "@v1/supabase/queries";
import { createClient } from "@v1/supabase/server";
import {
	DEFAULT_SERVER_ERROR_MESSAGE,
	createSafeActionClient,
} from "next-safe-action";
import { headers } from "next/headers";
import { z } from "zod";

export const actionClient = createSafeActionClient({
	handleReturnedServerError(e) {
		if (e instanceof Error) {
			return e.message;
		}

		return DEFAULT_SERVER_ERROR_MESSAGE;
	},
});

export const actionClientWithMeta = createSafeActionClient({
	handleReturnedServerError(e) {
		if (e instanceof Error) {
			return e.message;
		}

		return DEFAULT_SERVER_ERROR_MESSAGE;
	},
	defineMetadataSchema() {
		return z.object({
			name: z.string(),
			track: z
				.object({
					event: z.string(),
					channel: z.string(),
				})
				.optional(),
		});
	},
});

export const authActionClient = actionClientWithMeta
	.use(async ({ next, clientInput, metadata }) => {
		const result = await next({ ctx: null });

		if (process.env.NODE_ENV === "development") {
			logger("Input ->", clientInput);
			logger("Result ->", result.data);
			logger("Metadata ->", metadata);

			return result;
		}

		return result;
	})
	.use(async ({ next, metadata }) => {
		const ip = headers().get("x-forwarded-for");

		const { success, remaining } = await ratelimit.limit(
			`${ip}-${metadata.name}`,
		);

		if (!success) {
			throw new Error("Too many requests");
		}

		return next({
			ctx: {
				ratelimit: {
					remaining,
				},
			},
		});
	})
	.use(async ({ next, metadata }) => {
		const user = await getUser();
		const supabase = createClient();

		if (!user?.data) {
			throw new Error("Unauthorized");
		}

		// if (metadata) {
		//   const analytics = await setupAnalytics({
		//     userId: user.data.id,
		//     fullName: user.data.full_name,
		//   });

		//   if (metadata.track) {
		//     analytics.track(metadata.track);
		//   }
		// }

		return Sentry.withServerActionInstrumentation(metadata.name, async () => {
			return next({
				ctx: {
					supabase,
					user: user.data,
				},
			});
		});
	});