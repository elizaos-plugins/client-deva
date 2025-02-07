import { IAgentRuntime, Client, elizaLogger, type Plugin } from "@elizaos/core";
import { DevaClient } from "./devaClient.ts";
import { validateDevaConfig } from "./enviroment.ts";

export const DevaClientInterface: Client = {
    name: 'deva',
    async start(runtime: IAgentRuntime) {
        await validateDevaConfig(runtime);

        const deva = new DevaClient(
            runtime,
            runtime.getSetting("DEVA_API_KEY"),
            runtime.getSetting("DEVA_API_BASE_URL")
        );

        await deva.start();

        elizaLogger.success(
            `✅ Deva client successfully started for character ${runtime.character.name}`
        );

        return deva;
    },
};

const devaPlugin: Plugin = {
    name: "deva",
    description: "Deva client plugin",
    clients: [DevaClientInterface],
};
export default devaPlugin;
