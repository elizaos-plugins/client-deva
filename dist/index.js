// src/index.ts
import { elizaLogger as elizaLogger4 } from "@elizaos/core";

// src/devaClient.ts
import { elizaLogger as elizaLogger3 } from "@elizaos/core";

// src/base.ts
import { elizaLogger } from "@elizaos/core";
var ClientBase = class {
  runtime;
  accessToken;
  apiBaseUrl;
  defaultHeaders;
  constructor(runtime, accessToken, baseUrl) {
    this.runtime = runtime;
    this.accessToken = accessToken;
    this.apiBaseUrl = baseUrl;
    this.defaultHeaders = {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json"
    };
  }
  async getMe() {
    try {
      const response = await fetch(`${this.apiBaseUrl}/persona`, {
        headers: { ...this.defaultHeaders }
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      elizaLogger.error("Failed to fetch persona:", error);
      return null;
    }
  }
  async getPersonaPosts(personaId) {
    const res = await fetch(
      `${this.apiBaseUrl}/post?filter_persona_id=${personaId}`,
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json"
        }
      }
    ).then((res2) => res2.json());
    return res.items;
  }
  async makePost({
    text,
    in_reply_to_id
  }) {
    const res = await fetch(`${this.apiBaseUrl}/post`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text, in_reply_to_id, author_type: "BOT" })
    }).then((res2) => res2.json());
    console.log(res);
    return res;
  }
};

// src/controller.ts
import {
  composeContext,
  elizaLogger as elizaLogger2,
  generateText,
  getEmbeddingZeroVector,
  ModelClass,
  parseBooleanFromText,
  stringToUuid
} from "@elizaos/core";

// src/templates.ts
var DEVA_POST_TEMPLATE = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (!{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

{{recentMessages}}

# Task: Generate a post in the voice and style and perspective of {{agentName}}.
Write a 1-3 sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than 280. No emojis. Use \\n\\n (double spaces) between statements.
`;

// src/controller.ts
var DevaController = class {
  runtime;
  client;
  persona;
  posts;
  constructor(runtime, client) {
    this.runtime = runtime;
    this.client = client;
  }
  async init() {
    await this.populatePersona();
    await this.populatePosts();
    await this.startPosting();
  }
  async populatePersona() {
    this.persona = await this.client.getMe();
    if (!this.persona || !this.persona.id) {
      elizaLogger2.error("\u274C Deva Client failed to fetch Persona");
      throw new Error("\u274C Deva Client failed to fetch Persona");
    }
    elizaLogger2.log(
      `\u2728 Deva Client successfully fetched Persona: ${this.persona.username} ID: ${this.persona.id}`
    );
  }
  async populatePosts() {
    this.posts = await this.client.getPersonaPosts(this.persona.id);
    const existingMemories = await this.runtime.messageManager.getMemoriesByRoomIds({
      roomIds: this.posts.map(
        (post) => stringToUuid(
          post.in_reply_to_id + "-" + this.runtime.agentId
        )
      )
    });
    const existingMemoryIds = new Set(
      existingMemories.map((memory) => memory.id.toString())
    );
    const notExistingPostsInMemory = this.posts.filter(
      (post) => !existingMemoryIds.has(
        stringToUuid(post.id + "-" + this.runtime.agentId)
      )
    );
    for (const post of notExistingPostsInMemory) {
      elizaLogger2.log("Saving Post", post.id);
      const roomId = stringToUuid(
        post.in_reply_to_id + "-" + this.runtime.agentId
      );
      const userId = post.persona_id === this.persona.id ? this.runtime.agentId : stringToUuid(post.persona_id);
      if (post.persona_id === this.persona.id) {
        await this.runtime.ensureConnection(
          this.runtime.agentId,
          roomId,
          this.persona.username,
          this.persona.display_name,
          "deva"
        );
      } else {
        await this.runtime.ensureConnection(
          userId,
          roomId,
          post.persona.username,
          post.persona.display_name,
          "deva"
        );
      }
      const content = {
        text: post.text,
        inReplyTo: stringToUuid(
          post.in_reply_to_id + "-" + this.runtime.agentId
        ),
        source: "deva"
      };
      elizaLogger2.log("Creating memory for post", post.id);
      const memory = await this.runtime.messageManager.getMemoryById(
        stringToUuid(post.id + "-" + this.runtime.agentId)
      );
      if (memory) {
        elizaLogger2.log(
          "Memory already exists, skipping timeline population"
        );
        continue;
      }
      await this.runtime.messageManager.createMemory({
        id: stringToUuid(post.id + "-" + this.runtime.agentId),
        userId,
        content,
        agentId: this.runtime.agentId,
        roomId,
        embedding: getEmbeddingZeroVector(),
        createdAt: new Date(post.created_at).getTime()
      });
      elizaLogger2.log("Created memory for post", post.id);
    }
    elizaLogger2.log(
      `\u2728 Deva Client successfully fetched Persona Posts: ${this.posts.length}`
    );
  }
  async startPosting() {
    const shouldPostImmediately = this.runtime.getSetting("POST_IMMEDIATELY") != null && this.runtime.getSetting("POST_IMMEDIATELY") != "" && parseBooleanFromText(this.runtime.getSetting("POST_IMMEDIATELY"));
    if (shouldPostImmediately) {
      this.generateNewPost();
    }
    return this.setupPostAwaiter();
  }
  async setupPostAwaiter() {
    await this.populatePosts();
    const lastPost = this.posts.length > 0 ? this.posts[this.posts.length - 1] : null;
    const lastPostTimestamp = lastPost ? new Date(lastPost.updated_at).getTime() : 0;
    const minMinutes = parseInt(this.runtime.getSetting("POST_INTERVAL_MIN")) || 90;
    const maxMinutes = parseInt(this.runtime.getSetting("POST_INTERVAL_MAX")) || 180;
    const randomMinutes = Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
    const delay = randomMinutes * 60 * 1e3;
    if (Date.now() > lastPostTimestamp + delay) {
      await this.generateNewPost();
    }
    setTimeout(() => {
      this.setupPostAwaiter();
    }, delay);
    elizaLogger2.log(`Next post scheduled in ${randomMinutes} minutes`);
  }
  async generateNewPost() {
    elizaLogger2.log("Generating new Deva Post");
    const roomId = stringToUuid(
      "deva_generate_room-" + this.persona.username
    );
    await this.runtime.ensureUserExists(
      this.runtime.agentId,
      this.persona.username,
      this.persona.display_name,
      "deva"
    );
    const topics = this.runtime.character.topics.join(", ");
    const state = await this.runtime.composeState({
      userId: this.runtime.agentId,
      roomId,
      agentId: this.runtime.agentId,
      content: {
        text: topics,
        action: ""
      }
    });
    const customState = {
      ...state,
      agentName: this.persona.display_name,
      twitterUserName: this.persona.username,
      adjective: "Any adjective",
      topic: "Any topic"
    };
    const context = composeContext({
      state: customState,
      template: this.runtime.character.templates?.devaPostTemplate || DEVA_POST_TEMPLATE
    });
    const newPostContent = await generateText({
      runtime: this.runtime,
      context,
      modelClass: ModelClass.SMALL
    });
    await this.client.makePost({
      text: newPostContent,
      in_reply_to_id: null
    });
    console.log(newPostContent);
    elizaLogger2.log(`New Post published:
 ${newPostContent}`);
  }
};

// src/devaClient.ts
var DevaClient = class {
  runtime;
  clientBase;
  controller;
  constructor(runtime, accessToken, baseUrl) {
    elizaLogger3.log("\u{1F4F1} Constructing new DevaClient...");
    this.runtime = runtime;
    this.clientBase = new ClientBase(runtime, accessToken, baseUrl);
    this.controller = new DevaController(runtime, this.clientBase);
    elizaLogger3.log("\u2705 DevaClient constructor completed");
  }
  async start() {
    elizaLogger3.log("\u{1F680} Starting DevaClient...");
    try {
      await this.controller.init();
      elizaLogger3.log(
        "\u2728 DevaClient successfully launched and is running!"
      );
    } catch (error) {
      elizaLogger3.error("\u274C Failed to launch DevaClient:", error);
      throw error;
    }
  }
};

// src/enviroment.ts
import { z } from "zod";
var devaEnvSchema = z.object({
  DEVA_API_KEY: z.string().min(1, "Deva api key is required")
});
async function validateDevaConfig(runtime) {
  try {
    const config = {
      DEVA_API_KEY: runtime.getSetting("DEVA_API_KEY") || process.env.DEVA_API_KEY
    };
    return devaEnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map((err) => `${err.path.join(".")}: ${err.message}`).join("\n");
      throw new Error(
        `Deva configuration validation failed:
${errorMessages}`
      );
    }
    throw error;
  }
}

// src/index.ts
var DevaClientInterface = {
  name: "deva",
  async start(runtime) {
    await validateDevaConfig(runtime);
    const deva = new DevaClient(
      runtime,
      runtime.getSetting("DEVA_API_KEY"),
      runtime.getSetting("DEVA_API_BASE_URL")
    );
    await deva.start();
    elizaLogger4.success(
      `\u2705 Deva client successfully started for character ${runtime.character.name}`
    );
    return deva;
  },
  async stop(_runtime) {
    try {
      elizaLogger4.warn("Deva client does not support stopping yet");
    } catch (error) {
      elizaLogger4.error("Failed to stop Deva client:", error);
      throw error;
    }
  }
};
var index_default = DevaClientInterface;
export {
  DevaClientInterface,
  index_default as default
};
//# sourceMappingURL=index.js.map