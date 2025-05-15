// Mock AWS SDK S3
jest.mock("aws-sdk", () => {
  const mS3 = {
    listObjectsV2: jest.fn(),
    getObject: jest.fn(),
  };
  return {
    S3: jest.fn(() => mS3),
  };
});

// Mock the Lambda handler
jest.mock("./code/email-forward.js", () => ({
  handler: jest.fn((event, context, callback) => callback(null)),
}));

const AWS = require("aws-sdk");

describe("resend-emails.js", () => {
  let originalEnv;
  let s3Mock;
  beforeAll(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    originalEnv = { ...process.env };
    process.env.MailS3Bucket = "test-bucket";
    process.env.MailS3Prefix = "";
    process.env.EmailsMapping = '{"test@domain.com":["dest@domain.com"]}';
  });
  afterAll(() => {
    console.log.mockRestore();
    console.warn.mockRestore();
    process.env = originalEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    s3Mock = new AWS.S3();
  });

  it("should process all emails in S3 and call the handler", async () => {
    // Mock S3 to return two email keys
    s3Mock.listObjectsV2.mockImplementationOnce(() => ({
      promise: () =>
        Promise.resolve({
          Contents: [{ Key: "email1" }, { Key: "email2" }],
          IsTruncated: false,
        }),
    }));
    // Mock S3 getObject to return a raw email with a To header
    s3Mock.getObject.mockImplementation(({ Key }) => ({
      promise: () =>
        Promise.resolve({
          Body: `From: sender@domain.com\r\nTo: test@domain.com\r\nSubject: Test\r\n\r\nBody`,
        }),
    }));

    // Import and run the script
    const { main } = require("./resend-emails.js");
    await main();

    // Check that handler was called twice (once per email)
    const { handler } = require("./code/email-forward.js");
    expect(handler).toHaveBeenCalledTimes(2);
    // Check that the event passed to handler has the correct recipient
    const eventArg = handler.mock.calls[0][0];
    expect(eventArg.Records[0].ses.receipt.recipients[0]).toBe(
      "test@domain.com"
    );
  });

  it("should skip emails if To address is missing", async () => {
    s3Mock.listObjectsV2.mockImplementationOnce(() => ({
      promise: () =>
        Promise.resolve({
          Contents: [{ Key: "email1" }],
          IsTruncated: false,
        }),
    }));
    s3Mock.getObject.mockImplementation(({ Key }) => ({
      promise: () =>
        Promise.resolve({
          Body: `From: sender@domain.com\r\nSubject: Test\r\n\r\nBody`, // No To header
        }),
    }));

    const { main } = require("./resend-emails.js");
    await main();

    const { handler } = require("./code/email-forward.js");
    expect(handler).not.toHaveBeenCalled();
  });
});

async function listAllKeys(s3, Bucket, Prefix) {
  // ...
}

async function getRawEmail(s3, Bucket, Key) {
  // ...
}

async function main() {
  const AWS = require("aws-sdk");
  const s3 = new AWS.S3({ signatureVersion: "v4" });

  const keys = await listAllKeys(s3, emailBucket, emailKeyPrefix);
  // ...and so on, pass s3 to getRawEmail, etc.
}
