import { createContext, useContext } from 'react';

export const PersonalPrivySession = createContext({ logout: async () => {} });
export const usePersonalPrivy = () => useContext(PersonalPrivySession);
