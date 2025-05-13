const {
  parseEvent,
  transformRecipients,
  fetchMessage,
  handler,
  deleteMessage,
  processMessage,
} = require("./code/email-forward");

// Mock the AWS SDK
jest.mock("aws-sdk", () => {
  return {
    SES: {
      sendEmail: jest.fn().mockResolvedValue({}),
    },
    S3: jest.fn().mockImplementation(() => ({
      getObject: jest.fn().mockImplementation((params, callback) => {
        callback(null, {
          /* Mocked result object */
        });
      }),
      deleteObject: jest.fn().mockImplementation((params, callback) => {
        callback(null, {
          /* Mocked result object */
        });
      }),
    })),
  };
});

const badData = {
  config: {
    forwardMapping: {
      test: "forward@zz.com",
    },
    emailBucket: "emails-bucket",
    emailKeyPrefix: "",
  },
  event: {},
  log: jest.fn(),
};

const emailBody =
  "Dear valued recipient,\r\n\r\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.\r\n\r\nBest regards,\r\nSender";

const data = {
  config: {
    forwardMapping: {
      test: ["forward@zz.com", "forward2@zz.com"],
      test2: ["forward@zz.com", "forward2@zz.com", "forward3@zz.com"],
    },
    emailBucket: "emails-bucket",
    emailKeyPrefix: "",
  },
  event: {
    Records: [
      {
        eventSource: "aws:ses",
        eventVersion: "1.0",
        ses: {
          mail: { messageId: "test-id" },
          receipt: {
            recipients: ["test@thing.com"],
          },
        },
      },
    ],
  },
  emailData:
    `From: sender@example.com\r\nTo: test@thing.com\r\nSubject: Lorem Ipsum Test Email\r\n\r\n` +
    emailBody,
  outputEmailData:
    'From: "sender@example.com via test" <test@thing.com>\r\nTo: forward@zz.com,forward2@zz.com\r\nSubject: Lorem Ipsum Test Email\r\nReply-To: "Original Sender" <sender@example.com>\r\nList-Id: Forwarded emails via thing.com <bounce.thing.com>\r\nX-Forwarded-For: sender@example.com\r\n\r\n' +
    emailBody,

  log: jest.fn(),
  callback: jest.fn(),
  context: {},
  ses: {
    sendEmail: jest.fn().mockResolvedValue({}),
    sendRawEmail: jest.fn((params, callback) => {
      callback(null, {});
      return { promise: () => Promise.resolve({}) };
    }),
  },
  s3: {
    getObject: jest.fn((params, callback) => {
      callback(null, { Body: data.emailData });
      return { promise: () => Promise.resolve({ Body: data.emailData }) };
    }),
    deleteObject: jest.fn((params, callback) => {
      callback(null, {});
      return { promise: () => Promise.resolve({}) };
    }),
  },
};
describe("email-forward", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  describe("handler", () => {
    it("should handle the email forward", async () => {
      handler(data.event, data.context, data.callback, {
        config: data.config,
        log: data.log,
        ses: data.ses,
        s3: data.s3,
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(data.callback).toHaveBeenCalled();
      expect(data.ses.sendRawEmail).toHaveBeenCalledWith(
        {
          Destinations: ["forward@zz.com", "forward2@zz.com"],
          Source: "test@thing.com",
          RawMessage: { Data: data.outputEmailData },
        },
        expect.any(Function)
      );
      expect(data.ses.sendRawEmail).toHaveBeenCalledTimes(1);
      expect(data.s3.getObject).toHaveBeenCalled();
      expect(data.s3.deleteObject).toHaveBeenCalled();
      expect(data.log).toHaveBeenCalledWith({
        level: "info",
        message: "Process finished successfully.",
      });
    });

    it("should handle multiple recipients", async () => {
      const testData = { ...data };
      testData.event = {
        ...testData.event,
        Records: [
          {
            ...testData.event.Records[0],
            ses: {
              ...testData.event.Records[0].ses,
              receipt: {
                ...testData.event.Records[0].ses.receipt,
                recipients: ["test@thing.com", "test2@thing.com"],
              },
            },
          },
        ],
      };
      testData.emailData =
        `From: sender@example.com\r\nTo: test@thing.com,test2@thing.com\r\nSubject: Lorem Ipsum Test Email\r\n\r\n` +
        emailBody;
      const s3 = {
        ...testData.s3,
        getObject: jest.fn().mockImplementation((params, callback) => {
          callback(null, { Body: testData.emailData });
          return {
            promise: () => Promise.resolve({ Body: testData.emailData }),
          };
        }),
      };
      handler(testData.event, testData.context, testData.callback, {
        config: testData.config,
        log: testData.log,
        ses: testData.ses,
        s3: s3,
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(testData.callback).toHaveBeenCalled();
      expect(testData.ses.sendRawEmail).toHaveBeenCalledTimes(2);
      expect(testData.ses.sendRawEmail).toHaveBeenCalledWith(
        {
          Destinations: ["forward@zz.com", "forward2@zz.com"],
          Source: "test@thing.com",
          RawMessage: {
            Data:
              `From: "sender@example.com via test" <test@thing.com>\r
To: forward@zz.com,forward2@zz.com\r
Subject: Lorem Ipsum Test Email\r
Reply-To: "Original Sender" <sender@example.com>\r
List-Id: Forwarded emails via thing.com <bounce.thing.com>\r
X-Forwarded-For: sender@example.com\r
\r
` + emailBody,
          },
        },
        expect.any(Function)
      );
      expect(testData.ses.sendRawEmail).toHaveBeenCalledWith(
        {
          Destinations: [
            "forward@zz.com",
            "forward2@zz.com",
            "forward3@zz.com",
          ],
          Source: "test2@thing.com",
          RawMessage: {
            Data:
              `From: "sender@example.com via test2" <test2@thing.com>\r
To: forward@zz.com,forward2@zz.com,forward3@zz.com\r
Subject: Lorem Ipsum Test Email\r
Reply-To: "Original Sender" <sender@example.com>\r
List-Id: Forwarded emails via thing.com <bounce.thing.com>\r
X-Forwarded-For: sender@example.com\r
\r
` + emailBody,
          },
        },
        expect.any(Function)
      );
      expect(s3.getObject).toHaveBeenCalled();
      expect(s3.deleteObject).toHaveBeenCalled();
      expect(testData.log).toHaveBeenCalledWith({
        level: "info",
        message: "Process finished successfully.",
      });
    });
  });
  describe("processMessage", () => {
    it("should handle CC recipients correctly", async () => {
      const testData = { ...data };
      testData.event = {
        ...testData.event,
        Records: [
          {
            ...testData.event.Records[0],
            ses: {
              ...testData.event.Records[0].ses,
              receipt: {
                ...testData.event.Records[0].ses.receipt,
                recipients: ["test@thing.com", "test2@thing.com"],
                commonHeaders: { cc: ["cc1@example.com", "cc2@example.com"] },
              },
            },
          },
        ],
      };
      testData.emailData =
        `From: sender@example.com\r\nTo: test@thing.com,test2@thing.com\r\nSubject: Lorem Ipsum Test Email\r\ncc: cc1@example.com,cc2@example.com\r\n\r\n` +
        emailBody;
      const parsedData = await parseEvent(testData);
      const transformedData = await transformRecipients(parsedData);
      const result = await processMessage(transformedData);

      expect(result.emailData["test@thing.com"]).toContain(
        "\r\nCC: cc1@example.com,cc2@example.com\r\n"
      );
    });
  });
  describe("parseEvent", () => {
    it("should reject invalid SES messages", async () => {
      await expect(parseEvent(badData)).rejects.toThrow(
        "Error: Received invalid SES message."
      );
      expect(badData.log).toHaveBeenCalledWith({
        message: "parseEvent() received invalid SES message:",
        level: "error",
        event: JSON.stringify(badData.event),
      });
    });

    it("should parse valid SES messages", async () => {
      const result = await parseEvent(data);
      expect(result).toBe(data);
      expect(result.email).toBe(data.event.Records[0].ses.mail);
      expect(result.recipients).toBe(
        data.event.Records[0].ses.receipt.recipients
      );
    });
  });

  describe("transformRecipients", () => {
    // Existing test case
    it("should transform recipients", async () => {
      const parsedData = await parseEvent(data);
      const result = await transformRecipients(parsedData);
      expect(result.recipients).toEqual({
        "test@thing.com": ["forward@zz.com", "forward2@zz.com"],
      });
    });

    it("should transform multiple recipients", async () => {
      const testData = { ...data };
      testData.event = {
        ...testData.event,
        Records: [
          {
            ...testData.event.Records[0],
            ses: {
              ...testData.event.Records[0].ses,
              receipt: {
                ...testData.event.Records[0].ses.receipt,
                recipients: ["test@thing.com", "test2@thing.com"],
              },
            },
          },
        ],
      };
      const parsedData = await parseEvent(testData);
      const result = await transformRecipients(parsedData);
      expect(result.recipients).toEqual({
        "test@thing.com": ["forward@zz.com", "forward2@zz.com"],
        "test2@thing.com": [
          "forward@zz.com",
          "forward2@zz.com",
          "forward3@zz.com",
        ],
      });
    });
  });

  describe("fetchMessage", () => {
    it("should fetch the message from S3", async () => {
      const parsedData = await parseEvent(data);
      const transformedData = await transformRecipients(parsedData);

      // Clear any previous calls to our mocks
      data.s3.getObject.mockClear();
      data.s3.deleteObject.mockClear();

      const result = await fetchMessage(transformedData);

      expect(result.emailData).toBe(data.emailData);
    });
  });

  // Add a separate test for deleteMessage
  describe("deleteMessage", () => {
    it("should delete the message from S3", async () => {
      const parsedData = await parseEvent(data);
      const transformedData = await transformRecipients(parsedData);

      // Clear the mock
      data.s3.deleteObject.mockClear();

      await deleteMessage(transformedData);

      expect(data.s3.deleteObject).toHaveBeenCalledWith(
        {
          Bucket: "emails-bucket",
          Key: "test-id",
        },
        expect.any(Function)
      );
    });
  });

  describe("sendMessage", () => {
    it("should not sanitize recipient addresses before sending (should fail before fix)", async () => {
      const { sendMessage } = require("./code/email-forward");
      const dataWithWhitespace = {
        recipients: { "test@thing.com ": [" forward@zz.com"] },
        emailData: {
          "test @thing.com":
            "From: sender@example.com\r\nTo: test @thing.com\r\nSubject: Test\r\n\r\nBody",
        },
        log: jest.fn(),
        ses: {
          sendRawEmail: jest.fn((params, callback) => {
            callback(null, {});
          }),
        },
      };
      await sendMessage(dataWithWhitespace);
      // This should fail: params.Source should contain whitespace
      expect(dataWithWhitespace.ses.sendRawEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          Source: expect.stringContaining("test@thing.com"),
          Destinations: expect.arrayContaining(["forward@zz.com"]),
        }),
        expect.any(Function)
      );
    });
  });
});
