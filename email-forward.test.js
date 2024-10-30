const { parseEvent, transformRecipients, fetchMessage, handler, deleteMessage } = require('./code/email-forward');
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

const badData = {
    config: {
        forwardMapping: {
            'test': 'forward@zz.com',
        },
        emailBucket: 'emails-bucket',
        emailKeyPrefix: '',
    },
    event: {},
    log: jest.fn(),
};

const data = {
    config: {
        forwardMapping: {
            'test': ['forward@zz.com', 'forward2@zz.com'],
        },
        emailBucket: 'emails-bucket',
        emailKeyPrefix: '',
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
        getObject: jest.fn((params, callback) => {
            callback(null, { Body: 'rofl' });
            return { promise: () => Promise.resolve({ Body: 'rofl' }) };
        }),
        deleteObject: jest.fn((params, callback) => {
            callback(null, {});
            return { promise: () => Promise.resolve({}) };
        }),
    }
};
describe('email-forward', () => {

    describe('handler', () => {
        it('should handle the email forward', async () => {
            const ses = {
                sendRawEmail: jest.fn((params, callback) => {
                    callback(null, {});
                    return { promise: () => Promise.resolve({}) };
                })
            };

            handler(data.event, data.context, data.callback, {
                config: data.config,
                log: data.log,
                ses: ses,
                s3: data.s3
            });

            await new Promise(resolve => setImmediate(resolve));
            expect(data.callback).toHaveBeenCalled();
            expect(ses.sendRawEmail).toHaveBeenCalledWith({
                Destinations: ['forward@zz.com', 'forward2@zz.com'],
                Source: 'test@thing.com',
                RawMessage: { Data: 'rofl' }
            }, expect.any(Function));
            expect(data.s3.getObject).toHaveBeenCalled();
            expect(data.s3.deleteObject).toHaveBeenCalled();
            expect(data.log).toHaveBeenCalledWith({
                level: "info",
                message: "Process finished successfully."
            });
        });
    });

    describe('parseEvent', () => {
        it('should reject invalid SES messages', async () => {
            await expect(parseEvent(badData)).rejects.toThrow('Error: Received invalid SES message.');
            expect(badData.log).toHaveBeenCalledWith({
                message: "parseEvent() received invalid SES message:",
                level: "error", 
                event: JSON.stringify(badData.event)
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
            expect(result.recipients).toEqual(['forward@zz.com', 'forward2@zz.com']);
            expect(result.originalRecipient).toBe('test@thing.com');
        });

    });


    describe('fetchMessage', () => {
        it('should fetch the message from S3', async () => {
            const parsedData = await parseEvent(data);
            const transformedData = await transformRecipients(parsedData);
            
            // Clear any previous calls to our mocks
            data.s3.getObject.mockClear();
            data.s3.deleteObject.mockClear();

            const result = await fetchMessage(transformedData);

            expect(result.emailData).toBe('rofl');

        });
    });

    // Add a separate test for deleteMessage
    describe('deleteMessage', () => {
        it('should delete the message from S3', async () => {
            const parsedData = await parseEvent(data);
            const transformedData = await transformRecipients(parsedData);
            
            // Clear the mock
            data.s3.deleteObject.mockClear();
            
            await deleteMessage(transformedData);
            
            expect(data.s3.deleteObject).toHaveBeenCalledWith({
                Bucket: 'emails-bucket',
                Key: 'test-id'
            }, expect.any(Function));
        });
    });
});