import type { ReactNode } from "react";

function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

export const MenuIcon = () => (
	<Icon>
		<path d="M4 7h16M4 12h16M4 17h10" />
	</Icon>
);
export const PlusIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M12 5v14M5 12h14" />
	</Icon>
);
export const SendIcon = () => (
	<Icon>
		<path d="M12 19V5M5 12l7-7 7 7" />
	</Icon>
);
export const StopIcon = () => (
	<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
		<rect width="14" height="14" rx="3" fill="currentColor" />
	</svg>
);
export const CloseIcon = () => (
	<Icon>
		<path d="M6 6l12 12M18 6L6 18" />
	</Icon>
);
export const SearchIcon = () => (
	<Icon size={17}>
		<circle cx="11" cy="11" r="7" />
		<path d="M20 20l-3.5-3.5" />
	</Icon>
);
export const ChevronIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M9 6l6 6-6 6" />
	</Icon>
);
export const DownIcon = () => (
	<Icon size={18}>
		<path d="M12 5v14M5 12l7 7 7-7" />
	</Icon>
);
export const MoreIcon = () => (
	<Icon size={18}>
		<circle cx="5" cy="12" r="1" />
		<circle cx="12" cy="12" r="1" />
		<circle cx="19" cy="12" r="1" />
	</Icon>
);
export const KeyIcon = () => (
	<Icon size={18}>
		<circle cx="8" cy="15" r="4" />
		<path d="M11 12l9-9M16 7l3 3M14 9l2 2" />
	</Icon>
);
export const ArchiveIcon = () => (
	<Icon size={18}>
		<rect x="3" y="4" width="18" height="5" rx="1" />
		<path d="M5 9v10h14V9M10 13h4" />
	</Icon>
);
export const PinIcon = ({ size = 18 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4z" />
	</Icon>
);
export const SparkIcon = ({ size = 18 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
	</Icon>
);
export const FolderIcon = () => (
	<Icon size={15}>
		<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
	</Icon>
);
export const TerminalIcon = () => (
	<Icon size={15}>
		<path d="M4 17l6-5-6-5M12 19h8" />
	</Icon>
);
export const FileIcon = () => (
	<Icon size={15}>
		<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
		<path d="M14 3v5h5" />
	</Icon>
);
export const PencilIcon = () => (
	<Icon size={15}>
		<path d="M4 20h4L19 9l-4-4L4 16z" />
	</Icon>
);
export const ToolIcon = () => (
	<Icon size={15}>
		<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-2.4z" />
	</Icon>
);
export const CheckIcon = () => (
	<Icon size={14}>
		<path d="M5 12l5 5 9-10" />
	</Icon>
);
export const AlertIcon = () => (
	<Icon size={14}>
		<path d="M12 8v5M12 17h.01" />
		<circle cx="12" cy="12" r="9" />
	</Icon>
);
export const BotIcon = () => (
	<Icon size={15}>
		<rect x="4" y="8" width="16" height="12" rx="3" />
		<path d="M12 4v4M9 13h.01M15 13h.01M9 17h6" />
	</Icon>
);
export const CopyIcon = () => (
	<Icon size={15}>
		<rect x="9" y="9" width="11" height="11" rx="2" />
		<path d="M5 15V6a2 2 0 0 1 2-2h8" />
	</Icon>
);
export const AttachIcon = () => (
	<Icon>
		<path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.4 17.3a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
	</Icon>
);
