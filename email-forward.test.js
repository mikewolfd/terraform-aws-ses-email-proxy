const { parseEvent, transformRecipients, fetchMessage } = require('./code/email-forward');

// Mock the AWS SDK
jest.mock('aws-sdk', () => {
    return {
        SES: {
            sendEmail: jest.fn().mockResolvedValue({}),

        },
        S3: jest.fn().mockImplementation(() =>({
            getObject: jest.fn().mockImplementation((params, callback) => {
                callback(null, { /* Mocked result object */ });
            }),
            deleteObject: jest.fn().mockImplementation((params, callback) => {
                callback(null, { /* Mocked result object */ });
            }),

        }))
    };
});

const data = {
    config: {
        forwardMapping: {
            'test': 'forward@zz.com',
        },
        emailBucket: 'emails-bucket',
    },
    emailData: 'From: sender@example.com\r\nTo: recipient@example.com\r\nSubject: Test\r\n\r\nHello, world!',
    event: {
        Records: [
            {
                eventSource: 'aws:ses',
                eventVersion: '1.0',
                ses: {
                    mail: {messageId: 'test-id'},
                    receipt: {
                        recipients: ['test@thing.com'],
                    },
                },
            },
        ],
    },
    log: jest.fn(),
    callback: jest.fn(),
    context: {},
    ses: {
        sendEmail: jest.fn().mockResolvedValue({}),

    },
    s3: {
        getObject: jest.fn().mockImplementation((params, callback) => {
            callback(null, { Body: 'rofl' });
        }),
        deleteObject: jest.fn().mockImplementation((params, callback) => {
            callback(null, '{ /* Mocked result object */ }');
        }),
    }
};
describe('email-forward', () => {
    describe('parseEvent', () => {
        it('should reject invalid SES messages', async () => {

            await expect(parseEvent(data)).rejects.toThrow('Error: Received invalid SES message.');
            expect(data.log).toHaveBeenCalledWith({
                message: "parseEvent() received invalid SES message:",
                level: "error", event: JSON.stringify(data.event)
            });
        });

        it('should parse valid SES messages', async () => {
            const result = await parseEvent(data);
            expect(result).toBe(data);
            expect(result.email).toBe(data.event.Records[0].ses.mail);
            expect(result.recipients).toBe(data.event.Records[0].ses.receipt.recipients);
        });
    });

    describe('transformRecipients', () => {
        // Existing test case
        it('should transform recipients', async () => {
            const parsedData = await parseEvent(data)
            const result = await transformRecipients(parsedData);
            expect(result.recipients).toEqual(['forward@zz.com']);
            expect(result.originalRecipient).toBe('test@thing.com');
        });

    });
    describe('fetchMessage', () => {
        it('should fetch the message from S3', async () => {
            const parsedData = await parseEvent(data)
            const transformedData = await transformRecipients(parsedData);
            const result = await fetchMessage(transformedData);

            expect(result.emailData).toBe('rofl');
            console.log(result)
            expect(data.s3.getObject).toHaveBeenCalledWith({
                Bucket: 'emails-bucket',
                Key: 'test-id',
            },  expect.any(Function),
            );
            expect(data.s3.deleteObject).toHaveBeenCalledWith({
                Bucket: 'emails-bucket',
                Key: 'test-id',
            },  expect.any(Function),
            );
        });
    });
});