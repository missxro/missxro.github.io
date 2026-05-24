import type { Site, SocialObjects } from "./types";

export const SITE: Site = {
  website: "https://missxro.github.io/",
  author: "MissxRo",
  profile: "https://github.com/missxro",
  desc: "Blog personal dedicado a la informática.",
  title: "xRo's Blog",
  ogImage: "logo.png", // Pendiente para cambiar
  lightAndDarkMode: true,
  postPerIndex: 4, // Número de posts que se muestran en "recientes"
  postPerPage: 3, // Posts que se muestran por cada página
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
};

export const LOCALE = {
  lang: "es",
  langTag: ["es-ES"],
} as const;

export const LOGO_IMAGE = {
  enable: true,
  svg: true,
  width: 108,
  height:23,
};

export const SOCIALS: SocialObjects = [
  {
    name: "Github",
    href: "https://github.com/MissxRo",
    linkTitle: ` ${SITE.title} on Github`,
    active: true,
  },
  {
    name: "Instagram",
    href: "https://www.instagram.com/xrro.sh/",
    linkTitle: `${SITE.title} on Instagram`,
    active: false,
  },
  {
    name: "LinkedIn",
    href: "https://www.linkedin.com/in/rocio-del-pilar-felipe-maraver/",
    linkTitle: `${SITE.title} on LinkedIn`,
    active: false,
  },
  {
    name: "Mail",
    href: "mailto:roplay112@gmail.com",
    linkTitle: `Send an email to ${SITE.title}`,
    active: true,
  },
  {
    name: "Twitch",
    href: "https://www.twitch.tv/xrro_",
    linkTitle: `${SITE.title} on Twitch`,
    active: true,
  },
  {
    name: "Discord",
    href: "https://discordapp.com/users/294874107177205761",
    linkTitle: `${SITE.title} on Discord`,
    active: true,
  }
];
