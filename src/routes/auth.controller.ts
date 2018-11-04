import * as express from 'express';
import { Request } from 'express';
import { ObjectId } from 'mongodb';
import { isEmail } from 'validator';
import * as jwt from 'jsonwebtoken';
import CONFIG from '../config';
import { Member, MemberDto, IMemberModel } from '../models/member';
import { Permission } from '../models/permission';
import { multer, uploadToStorage, sendResetEmail } from '../utils';
import {
	JsonController,
	Post,
	Req,
	UseBefore,
	Body,
	UseAfter,
	BadRequestError,
	UnauthorizedError,
	Get,
	CurrentUser
} from 'routing-controllers';
import { ValidationMiddleware } from '../middleware/validation';

export const router = express.Router();

@JsonController('/api/auth')
@UseAfter(ValidationMiddleware)
export class AuthController {
	@Post('/signup')
	@UseBefore(multer.any())
	async signup(@Req() req: Request, @Body() member: MemberDto) {
		const { passwordConfirm } = req.body;
		const files: Express.Multer.File[] = req.files
			? (req.files as Express.Multer.File[])
			: new Array<Express.Multer.File>();

		if (!passwordConfirm) throw new BadRequestError('Please confirm your password');
		if (passwordConfirm !== member.password)
			throw new BadRequestError('Passwords did not match');
		member.graduationYear = Number(member.graduationYear);
		const maxYear = new Date().getFullYear() + 20;
		if (member.graduationYear < 1869 || member.graduationYear > maxYear)
			throw new BadRequestError(
				`Graduation year must be a number between 1869 and ${maxYear}`
			);

		const exists = await Member.findOne({ email: member.email }).exec();

		member.privateProfile = Boolean(member.privateProfile);
		member.unsubscribed = Boolean(member.unsubscribed);

		const picture = files.find(file => file.fieldname === 'picture');
		const resume = files.find(file => file.fieldname === 'resume');

		if (picture) member.picture = await uploadToStorage(picture, 'pictures', member);
		if (resume) member.resume = await uploadToStorage(resume, 'resumes', member);

		const user = new Member(member);
		await user.save();
		const u = user.toJSON();
		delete u.password;
		const token = jwt.sign({ _id: u._id }, CONFIG.SECRET, { expiresIn: '7 days' });
		return {
			user: u,
			token
		};
	}

	@Post('/login')
	async login(@Body() body: { email: string; password: string }) {
		const { email, password } = body;
		const user = await Member.findOne({ email }, '+password')
			.populate({ path: 'permissions', model: Permission })
			.exec();
		if (!user) throw new UnauthorizedError('Member not found');

		// Check if password matches
		if (!user.comparePassword(password)) throw new UnauthorizedError('Wrong password');

		const u = user.toJSON();
		delete u.password;

		// If user is found and password is right create a token
		const token = jwt.sign({ _id: u._id }, CONFIG.SECRET, { expiresIn: '7 days' });
		return {
			user: u,
			token
		};
	}

	@Get('/me')
	async me(@CurrentUser({ required: true }) user: IMemberModel) {
		// Renew user's auth token
		const token = jwt.sign({ _id: user._id }, CONFIG.SECRET, { expiresIn: '7 days' });
		return { user, token };
	}

	@Post('/forgot')
	async forgot(@Body() body: { email: string }) {
		const { email } = body;
		if (!email || !isEmail(email)) throw new BadRequestError('Please provide a valid email');
		const member = await Member.findOne({ email }).exec();
		if (!member) throw new BadRequestError(`There is no member with the email: ${email}`);
		const token = jwt.sign({ id: member._id }, CONFIG.SECRET, { expiresIn: '2 days' });
		member.resetPasswordToken = token;
		await member.save();
		await sendResetEmail(member);
		return `A link to reset your password has been sent to: ${email}`;
	}

	@Post('/reset')
	async reset(@Body() body: { password: string; passwordConfirm: string; token: string }) {
		const { password, passwordConfirm, token } = body;
		if (!password || password.length < 5)
			throw new BadRequestError('A password longer than 5 characters is required');
		if (!passwordConfirm) throw new BadRequestError('Please confirm your password');
		if (passwordConfirm !== password) throw new BadRequestError('Passwords did not match');

		if (!token) throw new UnauthorizedError('Invalid reset password token');
		let payload;
		try {
			payload = jwt.verify(token, CONFIG.SECRET) as object;
		} catch (error) {
			throw new UnauthorizedError('Invalid reset password token');
		}
		if (!payload) throw new UnauthorizedError('Invalid reset password token');
		const { id } = payload;
		if (!id || !ObjectId.isValid(id))
			throw new BadRequestError('Reset password token corresponds to an invalid member');
		const member = await Member.findById(id).exec();
		if (!member)
			throw new BadRequestError('Reset password token corresponds to a non existing member');
		if (member.resetPasswordToken !== token)
			throw new UnauthorizedError('Wrong reset password token for this member');
		member.password = password;
		member.resetPasswordToken = '';
		await member.save();
		return `Successfully changed password for: ${member.name}`;
	}
}