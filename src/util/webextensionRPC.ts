// A Remote Procedure Call abstraction around the message passing available to
// WebExtension scripts. Usable to call a function in the background script from
// a tab's content script, or vice versa.
//
// The calling side always gets a Promise of the return value. The executing
// (remote) function can be an async function (= it returns a Promise), whose
// completion then will then be waited for.

// Example use:
//
// === background.js ===
// function myFunc(arg) {
//     return arg*2
// }
// makeRemotelyCallable({myFunc})
//
// === content_script.js ===
// const myRemoteFunc = remoteFunction('myFunc')
// myRemoteFunc(21).then(result => { ... result is 42! ... })

import mapValues from 'lodash/fp/mapValues'
import { browser } from 'webextension-polyfill-ts'

// Our secret tokens to recognise our messages
const RPC_CALL = '__RPC_CALL__'
const RPC_RESPONSE = '__RPC_RESPONSE__'

export class RpcError extends Error {
    constructor(message) {
        super(message)
        this.name = this.constructor.name
    }
}

export class RemoteError extends Error {
    constructor(message) {
        super(message)
        this.name = this.constructor.name
    }
}

// === Initiating side ===

// The extra options available when calling a remote function
interface RPCOpts {
    tabId?: number
    throwWhenNoResponse?: boolean
}

// Union a type with these extra options
type WithExtraArgs<T> = T & RPCOpts

// Union a function's options with these extra args
type FuncWithExtraArgs<FuncT> = FuncT extends (a: infer Params) => infer Ret
    ? (a: WithExtraArgs<Params>) => Ret
    : never

// Union each function of an object with these extra args
type InterafceOfFuncsArgs<T> = { [P in keyof T]: FuncWithExtraArgs<T[P]> }

// Create a Proxy object that looks like the real interface but actually calls remote functions
// Example Usage:
//      interface AnalyticsInterface { trackEvent({}) => any }
//      const analytics = remoteInterface<AnalyticsInterface>()
//      analytics.trackEvent(...)
export function remoteInterface<T extends object>(): InterafceOfFuncsArgs<T> {
    // When the Proxy is asked for a property (such as a function of a class)..
    // return a function that executes the requested function over the RPC interface, instead of on that object itself
    return new Proxy<InterafceOfFuncsArgs<T>>({} as InterafceOfFuncsArgs<T>, {
        get(target, property, receiver): any {
            const methodName = property.toString()
            return function(...args) {
                let tabId
                let throwWhenNoResponse = null
                // todo: we're assuming a object parameter bag as the first argument here, clean that up.
                const params = args[0]
                // filter out tabId, pass that along to
                if (params.hasOwnProperty('tabId')) {
                    tabId = params.tabId
                    delete params.tabId
                }

                // todo: doesn't look like we really use this, audit and remove if we can.
                if (params.hasOwnProperty('throwWhenNoResponse')) {
                    throwWhenNoResponse = params.throwWhenNoResponse
                    delete params.throwWhenNoResponse
                }

                return remoteFunction(methodName, {
                    tabId,
                    throwWhenNoResponse,
                })(args)
            }
        },
    })
}

// Create a proxy function that invokes the specified remote function.
// Arguments
// - funcName (required): name of the function as registered on the remote side.
// - options (optional): {
//       tabId: The id of the tab whose content script is the remote side.
//              Leave undefined to call the background script (from a tab).
//   }
export function remoteFunction(
    funcName: string,
    {
        tabId,
        throwWhenNoResponse,
    }: { tabId?: number; throwWhenNoResponse?: boolean } = {},
) {
    throwWhenNoResponse =
        throwWhenNoResponse == null || throwWhenNoResponse === true
    const otherSide =
        tabId !== undefined
            ? "the tab's content script"
            : 'the background script'

    const f = async function(...args) {
        const message = {
            [RPC_CALL]: RPC_CALL,
            funcName,
            args,
        }

        // Try send the message and await the response.
        let response
        try {
            response =
                tabId !== undefined
                    ? await browser.tabs.sendMessage(tabId, message)
                    : await browser.runtime.sendMessage(message)
        } catch (err) {
            if (throwWhenNoResponse) {
                throw new RpcError(
                    `Got no response when trying to call '${funcName}'. ` +
                        `Did you enable RPC in ${otherSide}?`,
                )
            }
            return
        }

        // Check if it was *our* listener that responded.
        if (!response || response[RPC_RESPONSE] !== RPC_RESPONSE) {
            throw new RpcError(
                `RPC got a response from an interfering listener.`,
            )
        }

        // If we could not invoke the function on the other side, throw an error.
        if (response.rpcError) {
            throw new RpcError(response.rpcError)
        }

        // Return the value or throw the error we received from the other side.
        if (response.errorMessage) {
            console.error(
                `Error occured on remote side, please check it's console for more details`,
            )
            throw new RemoteError(response.errorMessage)
        } else {
            return response.returnValue
        }
    }

    // Give it a name, could be helpful in debugging
    Object.defineProperty(f, 'name', { value: `${funcName}_RPC` })
    return f
}

// === Executing side ===

const remotelyCallableFunctions = {}

async function incomingRPCListener(message, sender) {
    if (!message || message[RPC_CALL] !== RPC_CALL) {
        return
    }

    const funcName = message.funcName
    const args = message.hasOwnProperty('args') ? message.args : []
    const func = remotelyCallableFunctions[funcName]
    if (func === undefined) {
        console.error(`Received RPC for unknown function: ${funcName}`)
        return {
            rpcError: `No such function registered for RPC: ${funcName}`,
            [RPC_RESPONSE]: RPC_RESPONSE,
        }
    }
    const extraArg = {
        tab: sender.tab,
    }

    // Run the function
    let returnValue
    try {
        returnValue = func(extraArg, ...args)
    } catch (error) {
        console.error(error)
        return {
            errorMessage: error.message,
            [RPC_RESPONSE]: RPC_RESPONSE,
        }
    }

    try {
        returnValue = await returnValue
        return {
            returnValue,
            [RPC_RESPONSE]: RPC_RESPONSE,
        }
    } catch (error) {
        console.error(error)
        return {
            errorMessage: error.message,
            [RPC_RESPONSE]: RPC_RESPONSE,
        }
    }
}

// A bit of global state to ensure we only attach the event listener once.
let enabled = false

// Register a function to allow remote scripts to call it.
// Arguments:
// - functions (required):
//     An object with a {functionName: function} mapping.
//     Each function will be callable with the given name.
// - options (optional): {
//       insertExtraArg:
//           If truthy, each executed function also receives, as its first
//           argument before the arguments it was invoked with, an object with
//           the details of the tab that sent the message.
//   }

export function makeRemotelyCallable(
    functions: { [fnName: string]: (...args: any[]) => any },
    { insertExtraArg = false } = {},
) {
    // Every function is passed an extra argument with sender information,
    // so remove this from the call if this was not desired.
    if (!insertExtraArg) {
        // Replace each func with...
        const wrapFunctions = mapValues(func =>
            // ...a function that calls func, but hides the inserted argument.
            (extraArg, ...args) => func(...args),
        )
        functions = wrapFunctions(functions)
    }

    for (const functionName of Object.keys(functions)) {
        if (remotelyCallableFunctions.hasOwnProperty(functionName)) {
            const error = `RPC function with name ${functionName} has already been registered `
            // throw Error(error);
            console.warn(error)
        }
    }

    // Add the functions to our global repetoir.
    Object.assign(remotelyCallableFunctions, functions)

    // Enable the listener if needed.
    if (!enabled) {
        browser.runtime.onMessage.addListener(incomingRPCListener)
        enabled = true
    }
}

export class RemoteFunctionRegistry {
    registerRemotelyCallable(functions, { insertExtraArg = false } = {}) {
        makeRemotelyCallable(functions, { insertExtraArg })
    }
}

export function fakeRemoteFunction(functions: {
    [name: string]: (...args) => any
}) {
    return name => {
        return (...args) => {
            return Promise.resolve(functions[name](...args))
        }
    }
}
