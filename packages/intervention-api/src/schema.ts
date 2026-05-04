// GraphQL SDL — matches §7 Module E exactly, plus subscription & query helpers
// the UI uses for the live activity stream.

export const typeDefs = /* GraphQL */ `
  scalar JSON

  enum InterventionIntent {
    STATUS_QUERY
    ADD_CONTEXT
    UPDATE_GOAL
    PAUSE
    RESUME
    STOP
    OVERRIDE_DECISION
    REPLAY_ACTION
    DEVIATE
  }

  type InterventionResult {
    accepted: Boolean!
    requiresConfirmation: Boolean!
    diff: JSON
    reason: String
    auditId: ID!
  }

  type GateRequest {
    runId: ID!
    gate: String!
    expiresAt: Float!
  }

  type RunStatus {
    runId: ID!
    stage: String!
    status: String!
    costUsd: Float!
    etaSec: Float!
    goal: JSON!
    pendingGates: [GateRequest!]!
  }

  type Query {
    runs: [RunStatus!]!
    run(runId: ID!): RunStatus
    audit(runId: ID!): [JSON!]!
    interventions(runId: ID!): [JSON!]!
    decisionPack(runId: ID!): JSON
    slackMessages: JSON!
    outlookEmails: JSON!
    outlookEvents: JSON!
  }

  type Mutation {
    interveneRun(
      runId: ID!
      intent: InterventionIntent!
      payload: JSON!
      rationale: String
      operator: String!
      confirmed: Boolean
    ): InterventionResult!

    approveGate(runId: ID!, gate: String!, operator: String!): Boolean!
    rejectGate(runId: ID!, gate: String!, operator: String!, reason: String!): Boolean!
  }

  type RunEvent {
    type: String!
    runId: ID!
    detail: JSON!
    at: Float!
  }

  type Subscription {
    runEvents(runId: ID): RunEvent!
  }
`;
