const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractOtp } = require('../src/utils/otp');

const cases = [
    // Common formats and lengths
    ['Your OTP is 123456', '123456'],
    ['123456 is your verification code', '123456'],
    ['Use 4821 to verify your phone', '4821'],
    ['Your login code: 12345678', '12345678'],
    ['Your code is 12345. Do not share it.', '12345'],
    ['Dear Customer,Your OTP is 281035. Use this Passcode to complete your transaction. Thank you. -miniorange', '281035'],
    ['<#> 482913 is your Uber code. abcDEF12xyz', '482913'],
    // Prefixed and split codes
    ['G-482910 is your Google verification code.', '482910'],
    ['Your verification code is 123-456', '123456'],
    ['Your verification code is 123 456', '123456'],
    // Alphanumeric
    ['Your one-time password is AB12CD', 'AB12CD'],
    // Numbers that are not the code
    ['Rs. 5,000 debited from A/c XX1234. OTP 482913 valid for 10 mins', '482913'],
    ['INR 4500 paid. Your OTP is 7391', '7391'],
    ['Your OTP for 2025 renewal is 552190', '552190'],
    ['OTP 839201 expires in 1500 seconds', '839201'],
    ['Call 1800-123-4567 if you did not request code 445566', '445566'],
    ['Your code 9876 for order placed on 05/10/2026 at 10:30', '9876'],
    ['Amount $1200.50 charged. Security code: 3377', '3377'],
    ['Your OTP is 4821 for txn 556677', '4821'],
    ['Your OTP is 123456. Ref no 998877', '123456'],
    ['OTP for order #778899 is 2468', '2468'],
    ['Use code 5566 to login. Account ending 9988', '5566'],
    ['Transaction ID 99887766: your OTP is 314159', '314159'],
    ['Pay Rs 999 using OTP 112233', '112233'],
    ['Your Microsoft security code is 9302. Account ***@x.com', '9302'],
    ['Code: 0042', '0042'],
    ['Your PIN reset code is 000123', '000123'],
    ["WhatsApp code 123-456. Don't share this code with others", '123456'],
    ['Your verification code is 739 102 and expires in 5 minutes', '739102'],
    ['Your code is AB12-CD34', 'AB12-CD34'],
    // Other languages
    ['Tu código de verificación es 731902', '731902'],
    ['Ваш код подтверждения: 4417', '4417'],
    ['आपका ओटीपी 908172 है। इसे किसी के साथ साझा न करें।', '908172'],
    ['您的验证码是 663201，5分钟内有效', '663201'],
    // Long, multi-part message with the code near the end
    [`${'This is a long promotional preamble. '.repeat(40)}Finally, your verification code is 246810.`, '246810'],
    // No code
    ['<34>Oct  6 12:00:01 web01 sshd[1234]: Failed password for root from 10.0.0.5 port 22', null],
    ['Login failed: password expired for uid 5012 on port 2222', null],
    ['Your order #2025 has shipped and will arrive Monday.', null],
    ['Meeting moved to 10:30 on 05/10/2026', null],
    ['Your balance is Rs 15000', null],
    ['Hello there', null],
    ['', null],
    // Lone 6-digit number without a keyword is still the likely code
    ['482913', '482913'],
];

for (const [text, expected] of cases) {
    test(`extractOtp(${JSON.stringify(text.length > 60 ? text.slice(0, 57) + '...' : text)}) -> ${expected}`, () => {
        assert.equal(extractOtp(text), expected);
    });
}
