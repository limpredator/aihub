// Function-calling schema for the receptionist's conversational turn loop.
// Keep descriptions short — these go straight into the LLM's context on
// every turn, and voice latency is sensitive to prompt size.

export const receptionistFunctions = [
  {
    type: "function",
    function: {
      name: "route_to_extension",
      description: "Transfer the call to a known office extension.",
      parameters: {
        type: "object",
        properties: {
          extension: { type: "string", description: "The extension number to transfer to." },
        },
        required: ["extension"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "take_message",
      description: "Record a message for someone who isn't available, then end the call.",
      parameters: {
        type: "object",
        properties: {
          forExtension: { type: "string", description: "Intended recipient's extension, if known." },
          message: { type: "string", description: "The message content." },
          callbackNumber: { type: "string", description: "Caller's callback number, if given." },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "transfer_to_human",
      description: "Fall back to a human operator — caller is confused, upset, or the request is out of scope.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "end_call",
      description: "End the call after the caller's request has been resolved or they've said goodbye.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
] as const;
