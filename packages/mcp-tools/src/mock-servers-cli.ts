import { startMockSlack, startMockOutlook } from "./mock-servers.js";

const slackPort = Number(process.env.MOCK_SLACK_PORT ?? 5101);
const outlookPort = Number(process.env.MOCK_OUTLOOK_PORT ?? 5102);

startMockSlack(slackPort);
startMockOutlook(outlookPort);

console.log(`mock-slack    http://localhost:${slackPort}`);
console.log(`mock-outlook  http://localhost:${outlookPort}`);
